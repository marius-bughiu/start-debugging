---
title: "解決: 静的ファクトリーメソッドの [MemberNotNull] が効かず CS8618 が出続ける"
description: "CS8618 はコンストラクターを抜ける時点で検査され、静的メソッドの [MemberNotNull] はインスタンスメンバーに対して黙って無視されます。値はプライベートコンストラクターに渡してください。"
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "nullable"
lang: "ja"
translationOf: "2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method"
translatedBy: "claude"
translationDate: 2026-10-28
---

静的ファクトリーメソッドに `[MemberNotNull]` を付けても `CS8618` は消えません。この警告はコンストラクターに対して、コンストラクターを抜ける時点で報告され、その後にファクトリーが何をするかをコンパイラーは一切見ないからです。さらに、静的メソッドには `this` がないため、その `[MemberNotNull]` がインスタンスメンバーを指定していると、コンパイラーは属性を黙って無視します。メソッドにも警告は出ず、呼び出し側にも効果はありません。解決策は、代入をコンストラクターに戻すことです。ファクトリーで値を計算してプライベートコンストラクターに渡すか、メンバーを `required` にしてファクトリー内のオブジェクト初期化子で設定します。.NET 10 SDK 10.0.302 (C# 14) で検証済みです。この動作は `[MemberNotNull]` が C# 9 で導入されて以来変わっていません。

## エラーの状況

ビルド出力が指しているのは、属性を付けたファクトリーではなくプライベートコンストラクターです:

```
Widget.cs(8,13): warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor. Consider adding the 'required' modifier or declaring the property as nullable.
```

属性が無視されたことを知らせる 2 つ目の診断はありません。この沈黙こそが混乱の原因です。`[MemberNotNull(nameof(Name))]` は何かをしてくれそうに見えますし、ビルドにもそれを否定するものは何も出ません。

## 原因

ここでは 2 つの別々のルールが組み合わさっています。

**`CS8618` はコンストラクターごとに、その終了時点で検査されます。** コンパイラーは各コンストラクター本体 (およびフィールドとプロパティの初期化子) に対して null 許容のフロー解析を行い、閉じ波かっこの位置で 1 つだけ確認します。null 非許容の参照メンバーすべてに、null でない値が確実に代入されているか、です。コンストラクターから戻った後のオブジェクトは追跡しません。`var w = new Widget(); w.Name = name; return w;` というファクトリーは、`Name` が `null` のままコンストラクターが終了した後で `Name` を代入しており、警告が出るのはまさにその終了地点です。Roslyn チームは早い段階で、メソッド呼び出しをまたいだ初期化の追跡はしないと決めています ([dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358) の "We've decided not to track initialization interprocedurally for now")。`[MemberNotNull]` は、ちょうど 1 つのケースのための明示的な抜け道です。つまり、コンストラクターの *内部から* `this` に対して呼ばれるヘルパーです。

**静的メソッドの `[MemberNotNull]` が意味を持つのは静的メンバーだけです。** この属性は事後条件で、「このメソッドが戻ったとき、レシーバーのこれらのメンバーは null ではない」という意味です。インスタンスメソッドならレシーバーは `this` (または呼び出し対象のオブジェクト) です。静的メソッドにはレシーバーがないので、保証できるのは静的フィールドと静的プロパティだけです。インスタンスメンバーを指定すると、Roslyn は `nameof` を受け入れ (`nameof(Name)` はクラス内のどこでも有効なのでコンパイルは通ります)、その後アノテーションを捨ててしまいます。私は SDK 10.0.302 で両方を確認しました。`Nick` を一度も代入しない静的メソッドに `[MemberNotNull(nameof(Nick))]` を付けても `CS8774` は出ず、それを呼び出したインスタンスメソッドがその後 `Nick` を逆参照すると、やはり `CS8602` が出ます。同じ属性で静的フィールドを指定した場合は、検査も適用もされます。

つまり静的ファクトリーは二重に失敗しています。コンストラクターではないこと、そしてアノテーションが自分では説明できないメンバーを指定していることです。

## 最小の再現コード

```csharp
// .NET 10 SDK 10.0.302, C# 14, <Nullable>enable</Nullable>
using System.Diagnostics.CodeAnalysis;

public class Widget
{
    public string Name { get; set; }

    private Widget() { }                     // CS8618 is reported here

    [MemberNotNull(nameof(Name))]            // silently ignored: static method, instance member
    public static Widget Create(string name)
    {
        var w = new Widget();
        w.Name = name;
        return w;
    }
}
```

同じ誤りの 2 つ目の形は、インスタンスをパラメーターとして受け取り、コンストラクターから呼ばれる静的ヘルパーです。ドキュメントのパターンに見えますが、そうではありません:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public class Gadget
{
    public string Name { get; set; }

    public Gadget(string name) => Init(this, name);   // CS8618 still fires here

    [MemberNotNull(nameof(Name))]
    private static void Init(Gadget g, string name) => g.Name = name;
}
```

`[MemberNotNull]` が説明するのは呼び出しのレシーバーであり、`Init(this, name)` にはレシーバーがありません。`this` を引数として渡しても意味はありません。静的なまま機能するのは、ヘルパーとメンバーの両方が静的な場合だけです。たとえば静的コンストラクターから静的ローダーを呼ぶ場合です:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public static class Config
{
    public static string ConnectionString;

    static Config() => Load();                 // no CS8618: static helper, static member

    [MemberNotNull(nameof(ConnectionString))]
    private static void Load() => ConnectionString = "Server=.;Database=app";
}
```

## 解決方法の詳細

以下の解決方法はすべて、代入を `CS8618` から見える場所、つまりコンストラクターの中か、コンパイラーが理解できる契約の後ろへ戻すものです。推奨順に並べています。

### 1. 計算した値をプライベートコンストラクターに渡す

ほぼすべてのファクトリーにとって、これが正しい形です。ファクトリーが処理 (検証、解析、I/O) を行い、完成した値を代入だけを行うコンストラクターに渡します:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Widget
{
    public string Name { get; }

    private Widget(string name) => Name = name;

    public static Widget Create(string raw)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(raw);
        return new Widget(raw.Trim());
    }
}
```

属性も抑制も不要で、`Name` を読み取り専用にもできます。「生成してから代入する」形のファクトリーでは決して実現できないことです。メンバーが複数あるなら、コンストラクターのパラメーターを増やすだけです。プライベートな位置指定コンストラクターを持つ [record](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) は、同じ考え方をコンパクトにしたものです。

### 2. 静的ヘルパーを値を返す関数に変える

`Init(this, ...)` の形の場合は、ヘルパーが計算結果を返すように変更し、代入はコンストラクターに任せます:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Gadget
{
    public string Name { get; }

    public Gadget(string raw) => Name = Normalize(raw);

    private static string Normalize(string raw) => raw.Trim().ToLowerInvariant();
}
```

戻り値を持つ静的メソッドは、パラメーターを書き換えるメソッドよりテストしやすく、コンパイラーにはコンストラクター内の単純な代入として見えます。ヘルパーが複数の値を生成する場合は、タプルを返して分解します。`(Name, Slug) = Parse(raw);` は両方のメンバーへの確実な代入です。

### 3. ヘルパーをインスタンスメソッドにしてコンストラクターから呼ぶ

初期化が本当に共有したい手続き的なコードのかたまりなら、ヘルパーに残したままインスタンスメソッドにし、`[MemberNotNull]` が `this` を説明するようにします:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Report
{
    public string Title { get; private set; }

    private Report(string raw) => Normalize(raw);

    [MemberNotNull(nameof(Title))]
    private void Normalize(string raw) => Title = raw.Trim();

    public static Report Create(string raw) => new(raw);
}
```

これは [null 許容属性に関する Microsoft Learn のページ](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis#helper-methods-membernotnull-and-membernotnullwhen) に記載されているパターンです。静的な場合と違い、コンパイラーはヘルパーを検査します。`Normalize` が `Title` を代入せずに戻る可能性があれば、`CS8774: Member 'Title' must have a non-null value when exiting.` が出ます。

1 つ落とし穴があります。ファクトリーから新しいオブジェクトに対してインスタンスヘルパーを呼ぶ (`var r = new Report(); r.Normalize(raw);`) と、`[MemberNotNull]` は呼び出したレシーバーに適用されるので、ファクトリーの残りの部分では `r.Title` が null でないと扱われます。それでも `CS8618` には何の効果もありません。その行が実行される前に、コンストラクターはすでに終了しているからです。

### 4. メンバーを `required` にしてファクトリーでオブジェクト初期化子を使う

プロパティ形式での生成を好むなら、`required` によって責任がコンストラクターからオブジェクト生成式へ移り、生成できる場所はファクトリーだけになります:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Invoice
{
    public required string Number { get; init; }
    public required string Customer { get; init; }

    private Invoice() { }

    public static Invoice Create(string number, string customer) =>
        new() { Number = number.Trim(), Customer = customer.Trim() };
}
```

`required` メンバーはコンストラクターの責任ではないため、`CS8618` は消えます。元のファクトリーにはなかった安全網も手に入ります。どれか 1 つを忘れると、ビルドは `CS9035: Required member 'Invoice.Customer' must be set in the object initializer or attribute constructor.` で失敗します。これは警告ではなくエラーです。この契約の呼び出し側については [CS9035 の解説](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) を参照してください。

### 5. プライベートコンストラクターに `[SetsRequiredMembers]` を付ける

公開の呼び出し側向けに `required` メンバーを持つ型で、ファクトリーからは位置指定で値を渡したい場合は、すべてを設定すると約束するコンストラクターを追加します:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Tag
{
    public required string Value { get; init; }

    public Tag() { }

    [SetsRequiredMembers]
    private Tag(string value) => Value = value;

    public static Tag Create(string raw) => new(raw.Trim().ToLowerInvariant());
}
```

`[MemberNotNull]` と同様に、`[SetsRequiredMembers]` は検証されず信頼されるだけです。そのコンストラクターがメンバーを設定し忘れても、何も警告は出ません。目視で確認できるくらい短く保ってください。

### 6. 最終手段: プロパティではなくコンストラクターで抑制する

パラメーターなしのコンストラクターを要求し、後からメンバーを埋めるフレームワークが型を生成する場合は、抑制をそのコンストラクターだけに限定し、他の場所での解析を失わないようにします:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class LegacyRow
{
    public string Name { get; private set; }

#pragma warning disable CS8618 // Name is always assigned by Create before the instance escapes
    private LegacyRow() { }
#pragma warning restore CS8618

    public static LegacyRow Create(string name) => new() { Name = name };
}
```

何が起きているかを正直に表しており、コメントが次の読み手に、どのメソッドが約束を守っているかを伝えます。プロパティに `= null!` を付けるよりこちらを選んでください。`null!` は、その型が今後持つすべてのコンストラクターについて警告を黙らせます。後から追加され、本当に代入を忘れるコンストラクターも含めてです。

## 落とし穴とバリエーション

- **死んだ属性は削除します。** ファクトリーを直したら、インスタンスメンバーを指定している静的メソッドから `[MemberNotNull]` を取り除きます。何もしない上にコンパイラーは決して教えてくれず、次の人がそれをコピーします。ソリューション全体で `MemberNotNull` を検索し、各ヒットが `static` かどうかを確認すれば、すべて見つかります。

- **非同期ファクトリーは別の理由で `CS8774` に当たります。** コンストラクターは `await` できないので、そもそもファクトリーを使う理由はたいてい `static async Task<T> CreateAsync()` です。代わりにインスタンスのヘルパー `async Task InitAsync()` に `[MemberNotNull]` を付けると、コンパイラーはタスクの完了時ではなく、メソッドが呼び出し元に制御を返し得る `await` の地点で事後条件を検査します。そのため `await` の後でメンバーを代入しても `CS8774` が出ます。Roslyn はこれを仕様としています ([dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022))。解決策は 1 と同じで、静的ファクトリーの中で I/O を `await` し、その結果をプライベートコンストラクターに渡します。

- **`TryCreate` 型のファクトリーでは、メンバーではなく `out` パラメーターに注釈を付けます。** 呼び出し側が気にするのは返されたオブジェクトが null かどうかで、それはパラメーターの事後条件です:

  ```csharp
  // .NET 10 SDK 10.0.302, C# 14
  using System.Diagnostics.CodeAnalysis;

  public sealed class Sku
  {
      public string Code { get; }
      private Sku(string code) => Code = code;

      public static bool TryCreate(string? raw, [NotNullWhen(true)] out Sku? sku)
      {
          sku = string.IsNullOrWhiteSpace(raw) ? null : new Sku(raw.Trim());
          return sku is not null;
      }
  }
  ```

  メンバー自体は null 非許容で、プライベートコンストラクターによって保証されているので、ほかに属性は必要ありません。

- **コンストラクターには `[MemberNotNull]` を付けられません。** この属性の対象はメソッドとプロパティだけです。派生クラスのコンストラクターが基底クラスのメンバーを保証できるようにする要望は未解決のままです ([dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526))。代わりに `base(...)` で値を上へ渡してください。

- **別のオブジェクトに対して呼んだインスタンスヘルパーも効きますが、ローカルにだけです。** `other.Init(); other.Name.Length` はレシーバーが `other` なので警告になりません。ファクトリー本体の中では便利ですが、`other` を生成したコンストラクターを後からさかのぼって満たすことはありません。

- **遅延初期化されるメンバーは別の問題です。** `Name` が最初に使われるまで正当に値を持たないなら、それは null 許容にするか `Lazy<T>` の後ろに置くべきものです。`CS8618` と戦う前に、[Lazy&lt;T&gt; vs LazyInitializer vs double-checked locking](/ja/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/) で選択肢を比較してください。

## 関連記事

- [解決: CS8618 "Non-nullable property must contain a non-null value when exiting constructor"](/ja/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/): 警告全般と、インスタンスヘルパーに `[MemberNotNull]` を付けるパターンについて。
- [解決: CS9035 "Required member 'X' must be set in the object initializer"](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/): `required` ベースのファクトリーがメンバーを設定し忘れたときに出るエラーについて。
- [C# の record vs class vs struct: 判断マトリクス](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/): コンストラクターでの初期化が自然になる型の形を選ぶために。
- [C# の with 式は実際に何をコピーするのか](/ja/2026/10/what-does-a-csharp-with-expression-actually-copy/): 生成処理が期待したコードを飛ばしてしまう別のケースについて。
- [C# 14 の null 条件付き代入](/ja/2026/02/csharp-14-null-conditional-assignment/): コンパイラーが null をどう推論するかについてさらに詳しく。

## 参考資料

- Microsoft Learn, [Attributes interpreted by the compiler: Nullable static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis) ("Helper methods: MemberNotNull and MemberNotNullWhen" セクションと、コンストラクターから呼ぶヘルパーの例)。
- Microsoft Learn, [MemberNotNullAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.membernotnullattribute) (属性の対象: メソッドとプロパティ)。
- Microsoft Learn, [Nullable reference type warnings](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (`CS8618`、`CS8774`)。
- GitHub, [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358) (メソッド呼び出しをまたいだ初期化は追跡されない)。
- GitHub, [dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526) (`[MemberNotNull]` はコンストラクターに付けられない)。
- GitHub, [dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022) (非同期の `[MemberNotNull]` メソッドでの `CS8774` は仕様)。

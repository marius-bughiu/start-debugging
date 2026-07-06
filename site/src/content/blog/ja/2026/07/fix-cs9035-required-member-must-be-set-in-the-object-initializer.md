---
title: "解決: C# の CS9035「Required member 'X' must be set in the object initializer」"
description: "CS9035 は required とマークされたメンバーが割り当てられていないことを意味します。オブジェクト初期化子で割り当てるか、すべての required メンバーを設定する [SetsRequiredMembers] 付きのコンストラクターを追加します。"
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer"
translatedBy: "claude"
translationDate: 2026-07-06
---

`CS9035` は、`required` メンバーを持つ型のインスタンスを作成しながら、そのメンバーを割り当てていないときにコンパイル時に発生します。コンパイラーは、オブジェクトが構築を離れる前にすべての `required` フィールドまたはプロパティが設定されることを求めます。直接的な方法で修正しましょう。たとえば `new Person { Name = "Ada" }` のように、そのメンバーをオブジェクト初期化子に追加します。コンストラクターがすでにそのメンバーを割り当てている場合は、そのコンストラクターに `[SetsRequiredMembers]` を付けて、初期化子を要求しないようコンパイラーに伝えます。これは .NET 11 上の C# 14 で検証していますが、`required` 修飾子とこの診断は .NET 7 上の C# 11 以来同じように動作します。

## コンテキストの中でのエラー

完全なメッセージは、コンパイラーに欠けている正確なメンバーを名指しします。

```
error CS9035: Required member 'Person.Name' must be set in the object initializer or attribute constructor.
```

割り当てられていない required メンバーごとに `CS9035` が 1 つ表示されるため、required プロパティが 3 つある型で空の `new Person()` を書くと、一度に 3 つのエラーが出ます。これはコンパイル時の診断であり、ランタイムの例外ではありません。ビルドが失敗し、何も実行されません。それが `required` の目的そのものです。チェックは、本番で遭遇する `NullReferenceException` から、エディターで見える赤い波線へと移りました。

## なぜこれが起こるのか

C# 11 で導入された `required` 修飾子は、フィールドまたはプロパティを初期化時に必須としてマークします。任意の式が型の新しいインスタンスを構築するとき、コンパイラーは、オブジェクト初期化子を通じてか、それらを設定すると約束するコンストラクターを通じてか、すべての `required` メンバーが割り当てられていることを検証します。それを証明できない場合、`CS9035` を発行します。

鍵となる言葉は「証明する」です。コンパイラーはあなたのコードを実行しません。コンパイラーが信頼するのは 2 つだけです。オブジェクト初期化子で直接割り当てるメンバーと、`[SetsRequiredMembers]` で明示的に注釈されたコンストラクターです。本体でたまたまそのメンバーを割り当てているが属性を欠くコンストラクターは、まったくカウントされません。コンパイラーはそれを突き止めるために本体を読みはしません。だからこそ、コンストラクターが明らかに値を設定していても、エラーは残るのです。コンパイラーに見せるのではなく、伝えなければなりません。

3 つの状況がエラーを生みます。

- すべての `required` メンバーを割り当てずに `new T()` または `new T { ... }` を呼び出す。
- required メンバーを設定するコンストラクターを書いたが `[SetsRequiredMembers]` を忘れたため、コンパイラーが依然として初期化子を要求する。
- 基底型のメンバーに `required` を追加したが、派生型の構築パスがそれをもはや満たさない。

## 最小限の再現

`CS9035` を引き起こす最小の型です。

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }   // not required, optional
}
```

これらの構築のいずれもコンパイルに失敗します。

```csharp
// .NET 11, C# 14
var a = new Person();                        // CS9035 x2 (Name and Email)
var b = new Person { Name = "Ada" };         // CS9035 x1 (Email still missing)
var c = new Person { Age = 36 };             // CS9035 x2 (Name and Email)
```

両方の required メンバーが存在するときにのみコンパイルされます。

```csharp
// .NET 11, C# 14 -- compiles
var ok = new Person { Name = "Ada", Email = "ada@example.com" };
```

`Age` が省略されていて、それで問題ないことに注目してください。`required` はメンバーごとです。オプションのメンバーはオプションのままです。コンパイラーが気にするのは、`required` 修飾子を持つメンバーが割り当てられていることだけです。

## 詳細な修正方法

これらの選択肢を順番に進めてください。最初のものが大半のケースの答えです。残りは、初期化子が求めるものではない状況をカバーします。

### 1. オブジェクト初期化子で required メンバーを割り当てる

意図された修正は、呼び出し側ですべての required メンバーを設定することです。

```csharp
// .NET 11, C# 14
var person = new Person
{
    Name = "Ada Lovelace",
    Email = "ada@example.com",
    // Age is optional, omit it freely
};
```

これが `required` の目的です。型の契約はこれらのフィールドが必須だと述べ、初期化子はそれを守ります。同じ値を繰り返していることに気づいたら、それは型がコンストラクターを求めているという合図です。それが次の修正です。

### 2. [SetsRequiredMembers] で注釈したコンストラクターを追加する

コンストラクターがすでに値を受け取って割り当てているなら、`System.Diagnostics.CodeAnalysis.SetsRequiredMembers` で装飾します。この属性は、コンストラクターがすべての required メンバーを初期化するとコンパイラーに保証するため、呼び出し側はもはやオブジェクト初期化子を必要としません。

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }

    [SetsRequiredMembers]
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }
}

// now this compiles, no initializer needed
var person = new Person("Ada", "ada@example.com");
```

1 つの鋭い落とし穴があります。`[SetsRequiredMembers]` は表明であって、検証された保証ではありません。コンパイラーはあなたの言葉を信じ、コンストラクターが実際にすべての required メンバーを割り当てているかは検証しません。属性を追加したのに本体で `Email` の設定を忘れると、`CS9035` も警告も出ず、値を約束した場所に `null` が入るだけです。属性を正直に保ってください。

注釈されたコンストラクターの隣にパラメーターなしのコンストラクターを残す場合、パラメーターなしのバージョンの呼び出し側は依然として初期化子を必要とします。属性は、それが乗っている特定のコンストラクターだけを免除します。

### 3. メンバーが実際には必須でないなら `required` を外す

メンバーに妥当な既定値があるか、本当にオプションであるなら、そもそも `required` であるべきではありません。修飾子を外すと義務がなくなります。

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public string Email { get; init; } = "";   // was required, now optional with a default
}
```

これが正しい選択であることは驚くほど多いです。妥当な既定値がなく、値なしでの構築がオブジェクトを無効な状態に置いてしまう場合にのみ `required` に手を伸ばしてください。プロパティに既定値を与えて `required` を外すほうが、すべての呼び出し箇所に空文字列を渡させるより清潔です。

### 4. record には位置指定または [SetsRequiredMembers] コンストラクターを使う

位置指定 record はパラメーターごとに `init` プロパティを生成しますが、それらは既定では `required` ではありません。プライマリコンストラクターを持つ record に `required` プロパティを明示的に追加すると、プライマリコンストラクターはそれを自動的には満たさず、位置指定形式を使うと `CS9035` が出ます。コンストラクターがカウントされるべきに見えるので、これは人を混乱させます。その理由については [dotnet/csharplang #6780](https://github.com/dotnet/csharplang/discussions/6780) の設計に関する議論を参照してください。修正は、位置指定の呼び出しの上に初期化子でそのプロパティを設定するか、それを割り当てるコンストラクターに `[SetsRequiredMembers]` を追加することです。

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public record Product(string Sku)
{
    public required string Name { get; init; }

    [SetsRequiredMembers]
    public Product(string sku, string name) : this(sku) => Name = name;
}

// both work now
var withInit = new Product("A-100") { Name = "Widget" };
var withCtor = new Product("A-100", "Widget");
```

record の構築全体を位置指定パラメーターを通じて強制したいなら、`required` プロパティより素の `init` プロパティを優先してください。位置指定 record と `required` メンバーを混ぜるのは混乱の元です。型がどちらのモデルを使うかを決めてください。record が価値を持つのはいつかというより広い見方については、[C# の record vs class vs struct](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) を参照してください。

## 落とし穴とバリエーション

一握りの状況が、メッセージからは明らかでない理由で `CS9035` またはそれに似たものを生み出します。

- **`[SetsRequiredMembers]` は信頼であって証明ではありません。** 上で述べたとおり、コンパイラーはコンストラクターを検証しません。required メンバーをスキップする、属性付きのコンストラクターは、きれいにコンパイルされ、あなたに `null` を手渡します。属性は、あなたが守る責任を負う契約として扱ってください。

- **System.Text.Json は `required` を尊重します。** .NET 8 以降、JSON デシリアライザーは required メンバーを強制します。受信 JSON が required プロパティを省略すると、デシリアライズは、半分だけ構築されたオブジェクトを生成する代わりに、ランタイムで `JsonException` をスローします。これは `CS9035` ではなくランタイムのエラーですが、デシリアライズのパスに現れる同じ契約です。required メンバーに言及するデシリアライズの失敗を見たら、JSON には型が要求するフィールドが欠けています。そのエラーの一般的な形については [JSON 値を変換できませんでした](/ja/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) を、独自の構築ロジックが必要なら [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) を参照してください。オブジェクトを自分で構築する converter は required メンバーのチェックをかわすので、あなたが所有しない型が抵抗してくるときの逃げ道にもなります。

- **リフレクションと `Activator.CreateInstance` はチェックを完全にバイパスします。** `required` はランタイムではなく C# コンパイラーによって強制されます。`Activator.CreateInstance(typeof(Person))` はコンパイルされて実行され、required 参照メンバーを `null` のまま残します。フレームワークが `[SetsRequiredMembers]` を尊重せずにリフレクションであなたのオブジェクトを構築すると、コンパイラーなら手書きで書かせなかったであろう「あり得ない」オブジェクトができてしまうことがあります。オブジェクトをマテリアライズする ORM やシリアライザーが常連の容疑者です。これらの型で修飾子に頼る前に、required メンバーをサポートしているか確認してください。これはエンティティで特に重要です。[EF Core 11 で record を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/) を参照してください。

- **継承は義務を下方向へ運びます。** 基底クラスに `required` メンバーがあると、すべての派生型も構築時にそれを満たさなければならず、それを設定しない派生コンストラクターは `[SetsRequiredMembers]` を必要とするか、要件を呼び出し側の初期化子に委ねます。基底メンバーに `required` を追加することは、メンバーがオプションであることに頼っていた階層内のすべてのコンストラクターにとって、ソースを壊す変更です。

- **`init` と `set` の違いは `required` には関係ありません。** `required` はセッターのアクセシビリティと直交します。`required` メンバーは `init`（構築時のみ設定可能）でも通常の `set` でもマークできます。修飾子はメンバーが割り当てられなければならないかを制御し、アクセサーはいつ割り当て可能かを制御します。一般的なパターンは `public required string Name { get; init; }` です。設定が必須で、構築時のみです。

- **メンバーは少なくとも型と同じくらいアクセス可能でなければなりません。** `required` メンバーは、その型を構築できるあらゆるコードから設定可能でなければなりません。`internal` の init アクセサーを持つ `required` メンバーがある `public` 型は、別の診断（`CS9032`/`CS9033`）を生みます。外部の呼び出し側が型を構築できても、その要件を満たせないからです。required メンバーのアクセサーを狭めるなら、コンストラクターまたは型も狭めてください。

心に留めておくべきメンタルモデルはこうです。`required` は「これを提供しなければならない」というルールを、ランタイムの願いからコンパイル時の保証へと移し、`CS9035` はその保証が仕事をしている姿です。それを見たとき、修正は常に「呼び出し側で値を提供する」か「コンストラクターがすでにそれを提供しているとコンパイラーに伝える」のどちらかです。型にとってどちらが真かを決め、初期化子を埋めるか `[SetsRequiredMembers]` を追加してください。そして、メンバーを実際に設定せずにエラーを黙らせる手段として属性に手を伸ばさないでください。

## 関連

- [C# の record vs class vs struct: 意思決定マトリックス](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) は、`required` を上から振りかける前に正しい型の形を選ぶために。
- [EF Core 11 で record を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/) は、required メンバーが ORM がリフレクションでマテリアライズするエンティティとどう相互作用するかについて。
- [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) は、既定のシリアライザーがあなたの required メンバーと戦うときに構築を引き取るために。
- [解決: JSON 値を変換できませんでした](/ja/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) は、デシリアライズ時の同じ契約のランタイム側について。
- [C# 14 で拡張プロパティを宣言する方法](/ja/2026/06/how-to-declare-extension-properties-in-csharp-14/) は、C# 14 のプロパティモデルが何を表現でき、何を表現できないかについて。

## 出典

- Microsoft Learn, [required 修飾子 (C# リファレンス)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required)（`required` のセマンティクス、`SetsRequiredMembers` 属性、コンパイラーがコンストラクター本体を検証しないというルール）。
- Microsoft Learn, [オブジェクト初期化子とコレクション初期化子](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/object-and-collection-initializers)（required メンバーが初期化子または属性コンストラクターを通じて設定されなければならない仕組み）。
- GitHub, [dotnet/csharplang Discussion #6780](https://github.com/dotnet/csharplang/discussions/6780)（プライマリコンストラクターと明示的な `required` プロパティを組み合わせた record で `CS9035` が発生する理由）。

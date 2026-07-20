---
title: "解決: C# の CS8618「Non-nullable property must contain a non-null value when exiting constructor」"
description: "CS8618 は、null 非許容のフィールドまたはプロパティがコンストラクター終了時に初期化されていないことを意味します。コンストラクターで代入する、既定値を与える、required にする、または null 許容にして解決します。"
pubDate: 2026-07-20
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "nullable"
lang: "ja"
translationOf: "2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor"
translatedBy: "claude"
translationDate: 2026-07-20
---

`CS8618` は、null 非許容の参照メンバー（フィールドまたは自動プロパティ）が、コンストラクター終了時に非 null の値を持つことを保証できないときに発生します。コンパイラーはそのメンバーが代入されたことを証明できないため、`null` が漏れ出す可能性があると警告します。おおよその推奨順に、次の 4 つのいずれかで修正します。コンストラクターで代入する、フィールド初期化子を与える、呼び出し側が必ず設定するよう `required` を付ける、あるいは `null` が本当に有効なら（`string?` として）メンバーを null 許容にします。これは C# 14 / .NET 11 で検証しています。この診断は null 許容参照型が C# 8 で登場して以来同じ挙動で、新規プロジェクトで null 許容コンテキストを既定で有効化したのは .NET 6 のリリースです。

## コンテキストの中でのエラー

現在のコンパイラーは、フィールドとプロパティの両方に対して統一された 1 つのメッセージを出力します。

```
warning CS8618: Non-nullable variable must contain a non-null value when exiting constructor. Consider declaring it as nullable.
```

より古い SDK（および今なお開いている多くの StackOverflow スレッド）では、フィールド固有・プロパティ固有の表現が表示されます。多くの人が実際に検索に入力するのはこちらです。

```
warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor.
warning CS8618: Non-nullable field '_name' must contain a non-null value when exiting constructor.
```

3 つとも同じ原因を持つ同じ診断です。*error* ではなく *warning* という語に注意してください。`CS8618` は既定ではビルドを止めません。プロジェクトに `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` または `<WarningsAsErrors>CS8618</WarningsAsErrors>` がある場合にのみビルドを壊すエラーになります。多くのチームは、null 安全性の穴を無視できないようにするため、まさにこれを設定しています。

## なぜ起きるのか

null 許容参照型は C# 8 で導入され、.NET 6 以降はテンプレートで既定有効です（`.csproj` の `<Nullable>enable</Nullable>`）。これは各参照型を 2 つの状態に分けます。null 非許容（`string`）と null 許容（`string?`）です。null 非許容のメンバーは「これは決して null にならない」という約束です。コンパイラーの仕事はその約束をあなたに守らせることであり、最も簡単に検査できる場所が構築時です。コンストラクターが戻るとき、すべての null 非許容フィールドと自動プロパティは、証明可能な形で非 null でなければなりません。コンパイラーがそれを証明できなければ `CS8618` になります。

重要な語は「証明可能」です。コンパイラーは静的解析を行うのであって、あなたのコードを実行するわけではありません。信頼するのは正確に 3 つだけです。フィールドまたはプロパティの初期化子、コンストラクター内での直接の代入、そしてそのメンバーを代入すると示すために注釈が付けられたヘルパーメソッドです。コンパイラーが追跡できない経路で値を代入するコンストラクターや、フレームワークが後から設定するだけのメンバーは、まったくカウントされません。これは [required メンバー診断 CS9035](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) の背後にあるのと同じ「示すのではなく証明せよ」というモデルです。コンパイラーはメソッド本体から意図を読み取ってはくれません。

微妙な落とし穴があります。コンストラクター内の null チェックでガードしても解決しません。`if (name is null) throw new ArgumentNullException(nameof(name));` のようなコードは*パラメーター*が null でないことを証明しますが、実際に代入しない限り、コンパイラーは*メンバー*を未代入と見なし続けます。これは十分な頻度で開発者を驚かせるため、Roslyn に長く残っている専用の issue があります。

## 最小再現

null 許容コンテキストを有効にしたプロジェクトで `CS8618` を引き起こす最小の型です。

```csharp
// .NET 11, C# 14, <Nullable>enable</Nullable>
public class Person
{
    public string Name { get; set; }    // CS8618: never assigned
    public string Email { get; set; }   // CS8618: never assigned
    public int Age { get; set; }        // fine, value type has a default
}
```

null 非許容の参照プロパティごとに 1 つ、計 2 つの警告が出ます。`Age` が静かなのは、値型が常に既定値（`0`）を持つからです。null 許容性の警告は参照型に関するものです。メンバーを 1 つだけ設定するコンストラクターを追加しても、やはり警告が出ます。

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name)
    {
        Name = name;      // Name is proven
    }

    public string Name { get; set; }
    public string Email { get; set; }   // CS8618: still not assigned on this path
}
```

コンパイラーは各コンストラクターを独立して検査します。いずれかのコンストラクターが null 非許容メンバーを未代入のまま残すと、そのコンストラクターが警告を生成します。

## 解決の詳細

これらの選択肢を順番に検討してください。最初の 3 つがほとんどの場合に望ましいもので、最後の 2 つは、メンバーがコンパイラーには見えない場所で実際に初期化される場合の逃げ道です。

### 1. コンストラクターでメンバーを初期化する

有効なオブジェクトを構築するのに値が必要なら、それをコンストラクターのパラメーターとして受け取り、代入します。これは警告があなたを促している設計です。

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }

    public string Name { get; set; }
    public string Email { get; set; }
}
```

両方のメンバーがすべての構築経路で証明可能に代入されるので、両方の警告が消えます。複数のコンストラクターがある場合は、代入が 1 か所に収まるよう 1 つを経由させます。`public Person() : this("John", "Doe") { }` は、連鎖したコンストラクターが仕事をするためコンパイラーを満足させます。

### 2. フィールド初期化子でメンバーに既定値を与える

妥当な既定値があり、すべての呼び出し側に値を渡させたくない場合は、メンバーを宣言した場所で初期化します。

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
}
```

フィールド初期化子はどのコンストラクター本体よりも前に実行されるので、メンバーはすべての経路で自動的に非 null になります。これは空文字列や `new List<string>()` コレクションのような、ほぼ任意扱いの値に対する最もすっきりした修正です。メンバーが実行時に決して null であるべきでないなら、型を null 許容にするよりもこちらが優れています。プロパティを読むすべての人にとって非 null の契約が保たれるからです。

### 3. メンバーを `required` にする（C# 11 以降）

メンバーが必須だがそのためのコンストラクターパラメーターは欲しくない場合は、`required` 修飾子を使います。これは義務を呼び出し側のオブジェクト初期化子へ移し、おまけに `CS8618` を静めます。オブジェクトが漏れ出す前にそのメンバーが設定されなければならないことを、コンパイラーが把握できるようになるからです。

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; set; }
    public required string Email { get; set; }
}

// the caller is now forced to set both
var p = new Person { Name = "Ada", Email = "ada@example.com" };
```

これは DTO や構成オブジェクトにとって、しばしば最良の現代的な答えです。定型的なコンストラクターも、偽の既定値も不要で、非 null の保証がすべての呼び出し箇所で強制されます。トレードオフとして、値の省略は型に対する警告ではなく、呼び出し箇所でのコンパイルエラー（`CS9035`）になります。これに頼る場合は、[CS9035 と required メンバー](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) の関連記事を読んで、呼び出し側のエラーがどう見えるかを把握してください。

### 4. `null` が有効な状態ならメンバーを null 許容にする

メンバーが本当に存在しないことがあり得るなら、`string` ではなく `string?` であるべきです。`?` を付けると、この値が null になり得ることをコンパイラーとすべての読み手に伝えます。これは正直であり、null チェックを値が消費される場所へ移します。

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string? MiddleName { get; set; }   // legitimately optional
}
```

決して実際には null にならないメンバーの警告を静めるためだけに、これに頼らないでください。実際には常に設定されるメンバーを null 許容にすると、幻の null チェック（または null 免除演算子 `!`）をすべての消費者に押し付けることになります。`?` は本当に任意である値のために取っておきましょう。

### 5. ヘルパーメソッドに `[MemberNotNull]` を注釈するか、フレームワークが初期化するメンバーには `null!` を使う

メンバーが初期化されているのに、コンパイラーが追跡する場所ではないことがあります。これを 2 つのツールがカバーします。

共有のプライベートメソッドが初期化を行う場合は、`[MemberNotNull]` でコンパイラーに伝えます。

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Student
{
    public string Major { get; set; }

    public Student() => SetMajor();

    [MemberNotNull(nameof(Major))]
    private void SetMajor(string? major = null) => Major = major ?? "Undeclared";
}
```

`[MemberNotNull]` は、メソッドが戻った後に名前付きメンバーが非 null であると主張します。そのため、それを呼び出すコンストラクターはメンバーを代入したと見なされます。`[SetsRequiredMembers]` と同様、これはコンパイラーが検証せずに信じる約束なので、正直に保ってください。

もう 1 つのケースは、フレームワークがリフレクションで設定するメンバーで、典型例は EF Core の `DbSet` です。基底の `DbContext` がこれらを設定しますが、コンパイラーはそれを見られないので、慣用句は `null!` で初期化することです。

```csharp
// .NET 11, EF Core 11
public class TodoContext : DbContext
{
    public TodoContext(DbContextOptions<TodoContext> options) : base(options) { }

    public DbSet<TodoItem> TodoItems { get; set; } = null!;
}
```

`null!` は「これは非 null だと見なせ。別の場所で設定されると知っている」と伝えます。これは修正ではなく的を絞った抑制なので、コンストラクターの外の何かが実際に初期化を行うときにのみ使ってください。このパターンは EF Core のコード全体に現れます。同じ理屈は ORM がマテリアライズするエンティティにも当てはまり、[EF Core 11 で record を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/) で扱っています。

## 落とし穴とバリエーション

いくつかの状況が、メッセージには明記されない理由で `CS8618` またはそれに近いものを生みます。

- **パラメーターの null チェックはメンバーを代入しません。** パラメーターが null のときに `ArgumentNullException` をスローすることは、パラメーターが非 null であることを証明しますが、コンパイラーのモデルではメンバーは未代入のままです。やはり `Name = name;` と書く必要があります。検証して代入すること。検証だけでは足りません。

- **`struct` の既定構築はコンストラクターを迂回します。** `struct` では、パラメーターなしの既定（`default(MyStruct)`、または明示的なパラメーターなしコンストラクターが実行されないときの `new MyStruct()`）が各フィールドをゼロ初期化し、null 非許容の参照フィールドを `null` のまま残します。`default` の箇所では警告は出ません。コンパイラーは struct の宣言されたコンストラクターについては警告しますが、呼び出し側がゼロ化されたインスタンスを得るのを止められません。struct の非 null フィールドを保証するために `required` やコンストラクターに頼らないでください。`default` 値がどちらも回避します。

- **リフレクションとシリアライザーはコンストラクターなしでオブジェクトを構築します。** `Activator.CreateInstance`、`System.Text.Json`、ORM は、あなたのメンバーを代入したはずのコンストラクターを実行せずにオブジェクトを構築できます。そのため、コンパイラーが非 null と証明したメンバーが、実行時に `null` になり得ます。`required` を使う場合、`System.Text.Json` は .NET 8 以降 required メンバーを尊重し、JSON がそれを省略すると `JsonException` をスローします。これは同じ契約の実行時側の半分です。型を JSON からどう構築するかを完全に制御する必要があるときは、[カスタム JsonConverter](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) が構築を丸ごと引き受けます。

- **フィールドを持つプロパティと `field` キーワード。** 通常の自動プロパティでは、解析が追跡するのはバッキングフィールドです。C# 14 の `field` キーワードを使ってアクセサーにロジックを加える場合、コンパイラーが合成するバッキングフィールドにも同じ規則が当てはまります。コンストラクター終了時に非 null でなければならないので、他のメンバーと同じように初期化してください。

- **`= default!` と `= null!`。** 参照メンバーではこれらは同じ意味です（参照型の `default` は `null`）。どちらも警告を静めます。参照メンバーには `null!` を推奨します。「今のところ意図的に null」と読めるからです。`default!` は、型パラメーターが値型になり得るジェネリックメンバーのために取っておきましょう。

- **全体をオフにするのはほぼ解決になりません。** `#nullable disable` でファイルやリージョンの周りに null 許容コンテキストの範囲を狭められますが、それはその 1 つのメンバーだけでなく、内側のすべてについて null 安全性の解析を捨てます。問題ないと分かっている 1 つのメンバーを静めたいなら、そのメンバーへの `null!` のほうがコンテキスト無効化よりはるかに的を絞れます。ファイル全体の `#nullable disable` は移行ツールであって、解決ではありません。

保つべきメンタルモデルはこうです。`CS8618` は、null 非許容メンバーが交わす約束をコンパイラーが強制しているものです。これを見たら、実際に何が真かを判断し、それに応じて行動してください。メンバーは必須（コンストラクターで代入するか `required` にする）、妥当な既定値がある（フィールド初期化子を与える）、本当に任意（`string?` にする）、あるいはコンパイラーに見えないコードが初期化する（`[MemberNotNull]` または `null!`）。呼び出し側が設定するはずのメンバーに `null!` で対処するのは、コンパイル時の警告を実行時の `NullReferenceException` へ移すだけであり、それこそが null 許容参照型が防ぐために存在するバグそのものです。

## 関連記事

- [解決: CS9035「Required member 'X' must be set in the object initializer」](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)。メンバーを `required` にした途端に受け取る、呼び出し側のエラーについて。
- [C# の record vs class vs struct: 意思決定マトリクス](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)。メンバーの初期化方法を決める前に型の形を選ぶために。
- [EF Core 11 で record を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)。DbSet の `null!` 慣用句と、ORM がリフレクションでマテリアライズするメンバーについて。
- [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)。シリアル化がコンストラクターを迂回するときに構築を引き受けるために。
- [C# 14 の null 条件付き代入](/ja/2026/02/csharp-14-null-conditional-assignment/)。日常のコードで C# が null をどう扱うかをさらに知るために。

## 出典

- Microsoft Learn, [Nullable reference type warnings (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings)（`CS8618` の正確なテキスト、「nonnullable reference not initialized」の節、および `[MemberNotNull]` と `null!` を含む 4 つの解決テクニック）。
- Microsoft Learn, [required modifier (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required)（`required` がどのように義務を呼び出し側へ移し、非 null チェックを満たすか）。
- Microsoft Learn, [Working with nullable reference types in EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/nullable-reference-types)（`DbSet` = `null!` パターンと、なぜコンパイラーが基底クラスの初期化を見られないか）。
- GitHub, [dotnet/roslyn Issue #60283](https://github.com/dotnet/roslyn/issues/60283)（なぜコンストラクター内の null チェックが `CS8618` を消さないか）。

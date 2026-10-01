---
title: "修正: C# 15 の union 型に対して網羅的な switch で CS8509 または CS0161 が出る場合"
description: ".Value ではなく union の値そのものに対して switch し、switch 式を使うか、switch 文には case null を追加します。switch 式は警告で済む null の網羅が、switch 文では必須になります。"
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "pattern-matching"
lang: "ja"
translationOf: "2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type"
translatedBy: "claude"
translationDate: 2026-10-01
---

`.Value` プロパティではなく union の値そのものに対して switch し、switch 式を優先してください。値を返すメソッドで switch 文が必要な場合は、`case null:` の分岐を追加するか、switch の後に `throw` を置きます。switch 文では、`default` の union が持つ null の `Value` まで網羅して初めて、コンパイラーが union に対する switch を完全と見なすためです。以下の挙動はすべて .NET 11 RC1 SDK (`11.0.100-rc.1.26425.128`、C# 15、`LangVersion` の上書きは不要) で確認したものです。

## エラーの状況

union を宣言し、すべてのケース型に対応したのに、コンパイラーは網羅していないと言ってきます。

```text
warning CS8509: The switch expression does not handle all possible values of its input type (it is not exhaustive). For example, the pattern '_' is not covered.
error CS0161: 'Pets.Describe(Pet)': not all code paths return a value
error CS0165: Use of unassigned local variable 's'
warning CS8655: The switch expression does not handle some null inputs (it is not exhaustive). For example, the pattern 'null' is not covered.
error CS8780: A variable may not be declared within a 'not' or an 'or' pattern or a union matching involving matching against either the instance, or its underlying value.
```

これら 5 つは、同じ誤解から生じる別々の症状です。C# 15 における union の網羅性は **union マッチング** の性質であり、union マッチングは特定の条件下でのみ働きます。その条件から外れると、通常の `object` に対するパターンマッチングに戻り、2 つの型パターンでは決して網羅的になりません。

## コンパイラーが switch を網羅的と見なさない理由

C# 15 の [union 仕様](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-exhaustiveness)は 1 行で述べています。union 型はそのケース型によって "exhausted" (尽くされた) と見なされるため、`switch` 式は union のすべてのケース型を処理していれば網羅的です。それ以外はすべて細則から導かれます。

1. **入力は union の値でなければなりません。** union マッチングが行われるのは、"when the input value of a pattern is of a union type or of a nullable of a union type" の場合だけです。`pet.Value` (型は `object?`) や、`object` にボックス化された union に対して switch すると、コンパイラーはケースの一覧を得られず、`_` を要求します。
2. **switch 文は switch 式より厳格です。** 未処理の `null` がある switch 式は、CS8655 の警告付きでコンパイルされます。一方、確実な代入や戻りパスの解析に使われる switch 文は、`null` も網羅されている場合にのみ完全と見なされます。そのため `switch` の終端に到達可能なままとなり、CS0161 または CS0165 が出ます。
3. **union の `Value` は常に null になり得ます。** `public union Pet(Cat, Dog)` は、`public object? Value { get; }` を持つ構造体に展開されます。`default(Pet)` は `null` を保持し、`new Pet((Cat)null!)` も同様です。仕様は[整合性 (well-formedness)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#well-formedness)の項でこれを挙げており、`Value` は "null or a value of a case type" です。
4. **型パラメーターは展開されません。** `union Result<T>(T, Exception)` のケース型 `T` には、デザインネーション付きのパターンマッチングは使えません。`T v` が union インスタンスと中身のどちらを検査すべきか、コンパイラーが証明できないためです。これが CS8780 です。

## 最小の再現コード

```csharp
// .NET 11 RC1 SDK 11.0.100-rc.1.26425.128, C# 15, <Nullable>enable</Nullable>
public record Cat(string Name);
public record Dog(string Name);
public union Pet(Cat, Dog);
public union MaybePet(Cat?, Dog);
public union Result<T>(T, Exception);

static class Pets
{
    // OK: no diagnostics
    static string A(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: pattern '_' is not covered
    static string B(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

    // CS0161: not all code paths return a value
    static string Describe(Pet p)
    {
        switch (p)
        {
            case Cat c: return c.Name;
            case Dog d: return d.Name;
        }
    }

    // CS8655: pattern 'null' is not covered (Cat? is a nullable case type)
    static string D(MaybePet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: a union boxed into object is just an object
    static string E(object o) => o switch { Cat c => c.Name, Dog d => d.Name };

    // CS8655: Nullable<Pet> can be null
    static string F(Pet? p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8780 on 'TV v'
    static string I<TV>(Result<TV> r) => r switch { TV v => v!.ToString()!, Exception e => e.Message };
}
```

メソッド `A` が基準です。union の値をそのまま switch 式に渡し、すべてのケース型に分岐があり、コンパイラーは何も言いません。他のメソッドはすべて、上の 4 つのルールのいずれかに違反しています。

## 修正の詳細

順番に確認してください。最初の項目で、実際の報告の大半は解決します。

### 1. `.Value` ではなく union に対してマッチングする

`Value` は `object?` として宣言されています。参照した時点で、union 型とそのケース一覧は失われます。union に対するパターンマッチングは、すでに中身を展開してくれます。`p is Cat c` は `p.Value` に対する検査としてコンパイルされるので、自分で `.Value` を持ち出す理由はありません。

```csharp
// .NET 11 RC1, C# 15
// Before: CS8509
static string Name(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

// After: exhaustive, no default arm
static string Name(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };
```

`object`、`IUnion`、またはジェネリックな `T` パラメーターを経由する union にも同じことが当てはまります。仕様の[解決済みの質問](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#resolved-confirm-that-a-type-parameter-is-never-a-union-type-even-when-constrained-to-one)によれば、型パラメーターは union 型に制約されていても、決して union 型にはなりません。RC1 では、`static string L<TU>(TU u) where TU : struct, IUnion => u switch { Cat c => ..., Dog d => ... }` は網羅性の判定にすら到達せず、CS8121 "An expression of type 'TU' cannot be handled by a pattern of type 'Cat'" で失敗します。シグネチャには具体的な union 型を使ってください。

部分的な例外が 1 つあります。RC1 では、`Value` に対するプロパティパターンは union の知識を引き継ぎます。`r switch { { Value: TV v } => ..., { Value: Exception e } => ... }` は CS8509 ではなく CS8655 だけを出しました。ただし仕様では "Should direct Value property matching follow Union rules?" が未解決の問題として残っているため、これを前提にしないでください。

### 2. switch 式を優先し、switch 文には `case null` を追加する

これが CS0161 / CS0165 のケースで、最も意外なものです。同じ分岐が式では動くからです。RC1 で 3 つのバリエーションを確認しました。

```csharp
// .NET 11 RC1, C# 15
public union Pet(Cat, Dog);
public closed class Shape;
public sealed class Sq : Shape;
public sealed class Ci : Shape;

// error CS0161
static string S1(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; } }

// compiles
static string S2(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; case null: return "none"; } }

// compiles: bool is exhaustive for statements
static int S3(bool b) { switch (b) { case true: return 1; case false: return 0; } }

// error CS0161: closed hierarchies behave like unions here
static int S4(Shape s) { switch (s) { case Sq: return 1; case Ci: return 0; } }
```

`S3` は、コンパイラーが switch 文でも網羅性を判定していることを示しています。コンパイラーが行わないのは、網羅されていない `null` を無視することです。switch 式は、欠けている `null` を null 許容の警告に格下げします (すべてのケース型が非 null の union であれば、何も出ません)。switch 文は、到達可能性の判定に完全な網羅性の答えを使い、その答えには `null` が含まれます。`#nullable disable` を有効にしても変わりません。RC1 のコンパイラーは、union と closed クラスの両方で CS0161 を報告します。

きれいな修正が 3 つあります。優先度の高い順に示します。

```csharp
// .NET 11 RC1, C# 15
using System.Diagnostics;

// a) Use an expression. Most switch statements that only return can be one.
static string Describe(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

// b) Cover null explicitly. Use this when a default union is a legitimate state.
static string Describe2(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
        case null: return "no pet";
    }
}

// c) Keep the statement and declare the end unreachable.
static string Describe3(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
    }
    throw new UnreachableException();
}
```

修正として `default:` を使うのは避けてください。コンパイルは通りますが、union に次に追加するケース型まで飲み込んでしまい、本来残しておきたい唯一の診断が失われます。

CS0165 の変種は、同じ問題が代入の形で現れたものです。`string s; switch (p) { case Cat c: s = ...; break; case Dog d: s = ...; break; } return s;` は、`s` が未代入のまま switch の終端に到達できるため失敗します。同じ 3 つの修正が当てはまります。

### 3. 型が null になり得ると言っている箇所では null を処理する

CS8655 は、コンパイラーが正しいケースです。次の 2 つの状況で出ます。

- ケース型の 1 つが null 許容である場合 (`union MaybePet(Cat?, Dog)` など)。仕様のルールは次のとおりです。いずれかのケース型が "maybe null" なら、`Value` の既定の null 状態は "maybe null" です。
- 入力が `Pet?` (`Nullable<Pet>`) で、それ自体が `null` になり得る場合。

`null` の分岐を追加してください。union では、`null` は null のインスタンスと、`Value` が null の union の両方にマッチします。

```csharp
// .NET 11 RC1, C# 15
static string D(MaybePet p) => p switch
{
    Cat c => c.Name,
    Dog d => d.Name,
    null => "none",
};
```

null 許容のケース型が意図しないものだった場合は、代わりに union 宣言から `?` を取り除いてください。

### 4. 型パラメーターのケース型ではデザインネーションを外す

`union Result<T>(T, Exception)` では、制約にかかわらず `T v` の分岐が CS8780 で失敗します。制約なし、`where T : notnull`、`where T : class`、`where T : struct` を試しましたが、RC1 では 4 つすべてで CS8780 が報告されます。うまくいくのは、変数なしの型パターンを使う方法か、ジェネリックなケースを `var` で最後に受ける方法です。

```csharp
// .NET 11 RC1, C# 15
public union Result<T>(T, Exception);

// Exhaustive and clean with notnull: prints "v:5" for new Result<int>(5)
static string W4<TV>(Result<TV> r) where TV : notnull =>
    r switch { TV => "v:" + r.Value, Exception => "e" };

// Match the concrete case first, let var take the rest
static string W3<TV>(Result<TV> r) =>
    r switch { Exception e => e.Message, var other => other.Value!.ToString()! };
```

`notnull` 制約がない場合、`TV =>` の形もコンパイルは通りますが、`TV` が null 許容型になり得るため CS8655 が加わります。なお、`var` は union を展開しません。`other` は中身ではなく `Result<TV>` であり、だからこそそこから `.Value` を読み取っています。

## 実行時の側面: default の union は例外を投げる

コンパイラーを黙らせることは、すべての値を処理することと同じではありません。ケース型がすべて非 null の union は、`default` に対して switch しても警告が出ません。

```csharp
// .NET 11 RC1, C# 15
public union Result2(int, Exception);

static string Show(Result2 r) => r switch { int v => v.ToString(), Exception e => e.Message };

Show(default); // System.Runtime.CompilerServices.SwitchExpressionException at runtime
```

仕様の解決済みの質問 "Default nullable state of `Value` property" は、`default(U).Value` が `null` であるのに対し、null 許容解析はケース型しか見ていないことを認めています。実際には、default の union は、代入されなかったフィールド、配列の要素、ジェネリックコードでの `default` の戻り値、union が設定されなかったデシリアライズ済みのペイロードとして現れます。これらの経路が存在するなら、コンパイラーが求めていなくても `null` の分岐を追加するか、境界で検証してください。同じ考え方は、[コンストラクターで設定されない非 null 許容プロパティ](/ja/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)にも当てはまります。アノテーションは意図を表すものであり、実行時の保証ではありません。

## 落とし穴と似たエラー

- **CS8846** ("However, a pattern with a 'when' clause might successfully match this value") は、あるケース型が `when` ガード付きでしか網羅されていないことを意味します。その型にガードなしの分岐を追加してください。union のバグではありません。
- **具体的な型名を挙げる CS8509** (たとえば "the pattern 'Dog' is not covered") は、誠実なバージョンのエラーです。本当にケース型が抜けています。共有の union にケースが追加されたとき、あらゆる場所でこの診断が出ます。これが `default` や `_` の分岐を避けるべき理由です。
- **インターフェースや基底クラスのケース型** は、そのサブタイプではなく、その型自体によって網羅されます。`union Shape(IShape, string)` では、`Circle` と `Square` の分岐は `IShape` を網羅しません。サブタイプの網羅性が必要なら、基底を [closed クラス階層](/ja/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/)にして、それをケース型として追加してください。
- **古いプレビュー。** .NET 11 Preview 2 のまま、[最初の union 型の発表](/ja/2026/04/csharp-15-union-types-dotnet-11-preview-2/)にあるように `UnionAttribute` と `IUnion` 型を手で宣言している場合、網羅性の診断はプレビュー間で変わっています。上記のエラーを追いかける前に RC1 にアップグレードしてください。
- **アナライザーと生成コード。** JSON コンバーターやモデルバインダーのように union を `object` として受け取るコードは、ルール 1 に該当します。シリアライザーとバインディングの挙動は、[System.Text.Json での C# union 型のシリアライズ](/ja/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/)と [ASP.NET Core 11 で union のバインディングが機能する範囲](/ja/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/)で扱っています。

## 関連記事

- 宣言構文と暗黙の変換については、[C# 15 の union 型が登場](/ja/2026/04/csharp-15-union-types-dotnet-11-preview-2/)をご覧ください。
- 上で確認した switch 文の挙動を共有する、[C# 15 の closed クラス階層](/ja/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/)。
- ワイヤー境界をまたぐ union については、[System.Text.Json での C# union 型のシリアライズ](/ja/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/)をご覧ください。
- `Result<T>` の union をタプルや out パラメーターと比較検討している場合は、[C# でメソッドから複数の値を返す方法](/ja/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/)をご覧ください。
- 同じ話の null 許容解析の側面については、[非 null 許容プロパティの CS8618 の修正](/ja/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)をご覧ください。

## 参考資料

- [C# 15 unions specification (csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md): union マッチング、網羅性、null 許容性、展開、および上で引用した解決済みの質問。
- [Union types reference on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union).
- [Pattern matching warnings, including CS8509, CS8655 and CS8846](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/pattern-matching-warnings).
- すべての診断と実行時の結果は、macOS 上の .NET 11 RC1 SDK `11.0.100-rc.1.26425.128`、`net11.0`、`<Nullable>enable</Nullable>` でローカルに再現しました。

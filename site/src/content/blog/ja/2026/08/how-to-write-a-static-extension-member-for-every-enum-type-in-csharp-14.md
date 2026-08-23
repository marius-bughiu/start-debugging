---
title: "C# 14 ですべての enum 型に適用される静的拡張メンバーを書く方法"
description: "struct, Enum 制約を付けたジェネリックな extension ブロックを宣言すれば、ソリューション内のすべての enum に Status.Values、Status.Count、Status.Parse が生えます。レシーバーの形、CS0704 と CS0428 の罠、そして Enum.GetValues をキャッシュすべき理由。"
pubDate: 2026-08-23
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
  - "enums"
lang: "ja"
translationOf: "2026/08/how-to-write-a-static-extension-member-for-every-enum-type-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-08-23
---

C# 14 では、*すべての* enum 型に一度に静的メンバーを追加する extension ブロックを 1 つだけ書けます。形は `extension<TEnum>(TEnum) where TEnum : struct, Enum` で、非ジェネリックな静的クラスの中に宣言し、メンバーが静的なのでレシーバーのパラメーター名は省略します。これでソリューション内のすべての enum に `Status.Values`、`Status.Count`、`Status.Parse("active")` が、enum ごとに 1 行も書かずに手に入ります。以下の内容はすべて .NET SDK 10.0.201、ランタイム 10.0.5 でコンパイルおよび実行して確認しました。

やっかいなのは、別々の 3 つの落とし穴があることです。型パラメーターはジェネリックメソッドの中からは到達できず、`System.Enum` がすでに持っている名前のメンバーは黙って隠され、素直な実装は呼び出しのたびに新しい配列を確保します。

## レシーバーが `Enum` ではなく `TEnum` でなければならない理由

すべての enum は `System.Enum` から派生するのだから `extension(Enum)` と書けば済む、と考えたくなります。これはコンパイルが通りますし、具体的な enum 型名からも解決されます。

```csharp
// .NET 10, C# 14 -- compiles and runs, but is a dead end
public static class B
{
    extension(Enum)
    {
        public static string Label => "Label:System.Enum";
    }
}

// both of these print "Label:System.Enum"
Console.WriteLine(Status.Label);
Console.WriteLine(Enum.Label);
```

基底型に宣言した静的拡張メンバーは、確かに派生 enum の型名を通じて到達できます。しかしそのブロックには型パラメーターがないため、ジェネリックな `Enum` の API を一切呼び出せません。`Enum.GetValues<TEnum>()`、`Enum.Parse<TEnum>`、`Enum.TryParse<TEnum>` こそが欲しい API であり、どれも `TEnum` を必要とします。それがなければ `typeof` によるリフレクションに逆戻りし、値ごとに `object` へボックス化することになります。

つまりレシーバーが型パラメーターを持たなければなりません。次に思いつくのは `where TEnum : Enum` ですが、これも実際に使うまではコンパイルが通ります。

```csharp
extension<TEnum>(TEnum) where TEnum : Enum
{
    public static TEnum[] Values => Enum.GetValues<TEnum>();
}
```

```
error CS0453: The type 'TEnum' must be a non-nullable value type in order to use it
as parameter 'TEnum' in the generic type or method 'Enum.GetValues<TEnum>()'
```

制約としての `Enum` は、抽象参照型である `System.Enum` 自身も許容します。ジェネリックな `Enum` のヘルパーはすべて `struct, Enum` に制約されているので、ブロック側もそれに合わせる必要があります。こうして機能する形はちょうど 1 つに絞られます。

## ブロックを 3 ステップで宣言する

1. **トップレベルで非ジェネリックな `static class` を作ります。** extension ブロックはそこにしか書けません。クラス名は呼び出し側に一切現れないので、`EnumExtensions` のように説明的な名前を選んでください。
2. **`extension<TEnum>(TEnum) where TEnum : struct, Enum` と書き、レシーバーのパラメーター名を省略します。** MS Learn は "the extension parameter doesn't need to include the parameter name if the only members are static" と明記しています。名前を落とすことが、このブロックが静的メンバーを持つという合図になります。名前付きレシーバーはインスタンスメンバー用です。
3. **ブロック内に `public static` メンバーを宣言します。** 呼び出し側で名指しした具体的な enum に束縛されるので、`Status.Values` と書けば `TEnum` は `Status` と推論されます。

```csharp
// .NET 10, C# 14
public static class EnumExtensions
{
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static TEnum[] Values => Enum.GetValues<TEnum>();
        public static int Count => Enum.GetValues<TEnum>().Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status { Draft = 1, Active = 2, Archived = 4 }
public enum Color { Red, Green, Blue }

Console.WriteLine(Status.Count);              // 3
Console.WriteLine(string.Join(",", Status.Values));  // Draft,Active,Archived
Console.WriteLine(Color.Parse("green"));      // Green
Console.WriteLine(Color.TryParse("BLUE", out var c));  // True
```

ブロック 1 つで、コンパイル対象のすべての enum が静的メンバーを 4 つ獲得しました。これが得られる価値のすべてであり、C# 14 より前には本当に表現できなかった部分です。周辺機能を復習したい場合は、[C# 14 拡張メンバーの概要](/ja/2026/02/csharp-14-extension-members/)が演算子と非ジェネリックなケースを扱っており、[拡張プロパティの宣言](/ja/2026/06/how-to-declare-extension-properties-in-csharp-14/)がプロパティ固有の規則をより深く掘り下げています。

## コンパイラーが実際に出力するもの

extension ブロックはランタイムの機能ではありません。すべては外側の静的クラス上の通常の静的メソッドに落とされ、加えて拡張のメタデータを保持するコンパイラー生成のマーカー型が作られます。実行時にクラスをリフレクションで覗くとそれが見えます。

```
--- emitted members on EnumExtensions ---
  NestedType <G>$1AEBB925A470955AA56007A9C9196757`1
  Method   get_Count
  Method   get_Values
  Method   Parse
  Method   TryParse
```

入れ子型 `<G>$<hash>` は、レシーバーとその制約を記録するためにコンパイラーが使うグループ化用の型です。メンバー自体はフラットな静的メソッドであり、そのため extension ブロックは `this` パラメーター形式の旧来の拡張メソッドとバイナリ互換であり、実行時のディスパッチコストもありません。

このフラットな出力には直接的な帰結があり、それが最初に驚かされる点です。

## extension ブロックはスコープではない

MS Learn はこの規則をはっきり述べています。"An extension doesn't introduce a scope for member declarations. All members declared in a single class, even if in multiple extensions, must have unique signatures." つまり、別々のブロックにあってもインスタンスメンバーと静的メンバーが同名なら衝突します。

```csharp
public static class E2
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Tag => "instance";
    }
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static string Tag => "static";   // CS0102
    }
}
```

```
error CS0102: The type 'E2' already contains a definition for 'Tag'
```

2 つの静的クラスに分ければ、衝突は代わりに呼び出し側へ移動し、そこには C# 14 専用の診断があります。

```
error CS9339: The extension resolution is ambiguous between the following members:
'C1.extension<Status>(Status).Count' and 'C2.extension<Status>(Status).Count'
```

CS9339 はひと目で見分けられるようにしておく価値があります。ジェネリックな enum ブロックはスコープ内のすべての enum に適用されるからです。`Values` 拡張を提供するライブラリが 2 つあれば、自分が持つすべての enum で衝突し、しかもどちらのライブラリにも非はありません。旧スタイルの拡張メソッドをブロックへ移して元を消し忘れたときにも同種の問題が起き、[拡張メンバーへの移行後の CS0121 あいまいエラー](/ja/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/)になります。

## `TEnum.Values` はジェネリックメソッド内ではコンパイルできない

これが最も時間を奪います。拡張メンバーは具体的な enum 名に対しては問題なく解決されますが、型パラメーターに対しては解決されません。

```csharp
public static int CountOf<TEnum>() where TEnum : struct, Enum
{
    return TEnum.Values.Length;   // CS0704
}
```

```
error CS0704: Cannot do non-virtual member lookup in 'TEnum' because it is a type parameter
```

静的拡張メンバーは型に対する名前検索で解決されますが、その目的においては型パラメーターは型ではありません。型パラメーター経由のメンバー検索に参加できるのは `static` *abstract* なインターフェイスメンバーだけであり、拡張メンバーはインターフェイスメンバーではありません。これを回避する構文は存在しません。

現実的な答えは、本当の実装を普通のジェネリックなヘルパークラスに置き、extension ブロックをその薄いファサードにすることです。ジェネリックなコードはヘルパーを直接呼び、アプリケーションコードは見た目のよい拡張メンバーを呼びます。この分割は後述のアロケーション問題も同時に解決するので、ついでに手に入ります。

## `Enum.GetValues<TEnum>()` は呼び出しごとに新しい配列を確保する

`Enum.GetValues<TEnum>()` は毎回新しい `TEnum[]` を返します。キャッシュした可変配列を渡してしまうと、どの呼び出し元からでも壊せてしまうからです。アクセスのたびにこれを呼ぶプロパティは、参照をアロケーションに変えてしまいます。ランタイム 10.0.5、Release ビルド、メンバー 5 個の enum に 100 万回アクセスし、JIT が呼び出しをループ外へ引き上げられないよう結果にインデックスアクセスして測定しました。

| 実装 | 時間 | 確保量 | 1 操作あたり |
| --- | --- | --- | --- |
| アクセスごとに `Enum.GetValues<TEnum>()` | 27.8 ms | 48,000,832 バイト | 48 B |
| 静的ジェネリックキャッシュ | 0.7 ms | 0 バイト | 0 B |

1 操作あたり 48 バイトは、配列ヘッダーに 4 バイト値 5 個を足し、アラインメントに丸めた値です。この数値は enum の規模に比例するので、メンバー 30 個の enum ならもっとかかります。3 回の実行を通じて、キャッシュなし版は 26.8 ms から 29.5 ms、キャッシュあり版は常に 0.7 ms でした。

解決策は静的なジェネリッククラスです。CLR は閉じたジェネリック型ごとにその静的フィールドの実体を 1 つ与えるので、`EnumInfo<Status>` と `EnumInfo<Color>` は別々の格納領域を持ち、それぞれ初回使用時にちょうど 1 回だけ初期化されます。

```csharp
// .NET 10, C# 14
internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();
}
```

ここで `TEnum[]` ではなく `ImmutableArray<TEnum>` であることが重要です。プロパティから渡されたキャッシュ済み配列はどの呼び出し元からも可変で、`Values[0] = ...` の 1 行がプロセス全体のキャッシュを黙って汚染します。`FrozenSet` は所属判定に適した形で、構築コストを一度だけ多めに払う代わりに読み取りが速くなります。これは型ごとの静的キャッシュが求めるトレードオフそのものです。この選択の根拠となる数値は [Dictionary と FrozenDictionary のベンチマーク](/ja/2024/04/net-8-performance-dictionary-vs-frozendictionary/)にあります。

## `System.Enum` がすでに持つ名前は隠される

拡張メンバーはフォールバックです。名前検索はまず本物のメンバーを見つけ、適用可能なものが何もないときにだけ拡張へ手を伸ばします。`System.Enum` はすでに `IsDefined` を宣言しているので、その名前の拡張メンバーは検討すらされません。

```csharp
extension<TEnum>(TEnum value) where TEnum : struct, Enum
{
    public bool IsDefined => Enum.IsDefined(value);
    public bool IsKnown => Enum.IsDefined(value);
}

Status s = Status.Active;
bool a = s.IsKnown;     // fine
bool b = s.IsDefined;   // CS0428
```

```
error CS0428: Cannot convert method group 'IsDefined' to non-delegate type 'bool'.
Did you intend to invoke the method?
```

コンパイラーは `Enum.IsDefined` のメソッドグループを見つけ、そこで探索をやめました。このエラーメッセージは積極的に誤解を招きます。括弧を忘れたかのように示唆しますが、本当の問題は拡張プロパティがその名前では到達不能だという点だからです。同じことは静的拡張メンバーにも起こります。静的拡張プロパティとして宣言した `Status.IsDefined` はまったく同じ CS0428 を出します。

これはシグネチャではなく名前の話である点に注意してください。拡張*メソッド*としての `GetValues` は問題なく動きます。

```csharp
extension<TEnum>(TEnum) where TEnum : struct, Enum
{
    public static TEnum[] GetValues() => Enum.GetValues<TEnum>();  // compiles
}

Status[] all = Status.GetValues();   // resolves to your extension
```

`Enum.GetValues` は存在しますが、引数ゼロで適用可能なオーバーロードがないため、検索は拡張まで落ちてきます。これに頼るのは脆弱です。安全な指針は、`System.Enum` にすでにある名前をすべて避けることです。`IsDefined`、`Parse`、`TryParse`、`GetName`、`GetNames`、`GetValues`、`GetUnderlyingType`、`Format`、`ToObject`、`HasFlag`、`CompareTo` が該当します。`Values`、`Count`、`Names`、`IsKnown` を選べばこの分類ごと回避できます。

`Parse` と `TryParse` は扱いにくい例外です。呼び出し側が期待するのはまさにその名前だからです。現時点では、`GetValues` と同じく適用可能なオーバーロードがゼロという理由で解決されます。保守的にいくなら `ParseName`、`TryParseName` と名付けてください。

## `[Flags]` 分解の罠

フラグ値を構成要素に分解するメンバーを追加する場合、素直な実装はゼロ値のメンバーを持つ enum に対して誤りになります。

```csharp
[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Admin = Read | Write }

public ImmutableArray<TEnum> NaiveFlags =>
    [.. EnumInfo<TEnum>.Values.Where(f => value.HasFlag(f))];
```

```
naive : [None, Read, Write, Admin]
```

`HasFlag` は部分集合の判定なので、`x.HasFlag(None)` はどの `x` に対しても真になり、`Admin` のような複合メンバーも一致してしまいます。ビットが 1 つだけ立ったメンバーに絞れば、両方の問題が一度に解決します。

```csharp
// .NET 10, C# 14 -- add to EnumInfo<TEnum>; needs using System.Numerics;
public static readonly ImmutableArray<TEnum> SingleBitFlags =
    [.. Enum.GetValues<TEnum>().Where(v =>
        BitOperations.PopCount(Convert.ToUInt64(v)) == 1)];

public ImmutableArray<TEnum> Flags =>
    [.. EnumInfo<TEnum>.SingleBitFlags.Where(f => value.HasFlag(f))];
```

```
fixed : [Read, Write]
none  : []
read  : [Read]
```

`Convert.ToUInt64` はボックス化しますが、静的初期化子の中で enum 型ごとに 1 回動くだけで、呼び出しごとではありません。

## 実際に出荷する価値のある版

要素をまとめると、キャッシュを保持するジェネリックヘルパー、型レベルのメンバー用の静的ブロック 1 つ、値レベルのメンバー用のインスタンスブロック 1 つ、そして `System.Enum` がすでに持つ名前は一切使わない、という形になります。

```csharp
// .NET 10, C# 14
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Reflection;

internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();

    public static readonly FrozenDictionary<TEnum, string> Descriptions =
        Enum.GetValues<TEnum>()
            .DistinctBy(v => v)
            .ToFrozenDictionary(
                v => v,
                v => typeof(TEnum).GetField(v.ToString())
                        ?.GetCustomAttribute<DescriptionAttribute>()?.Description
                     ?? v.ToString());
}

public static class EnumExtensions
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Description => EnumInfo<TEnum>.Descriptions[value];
        public bool IsKnown => EnumInfo<TEnum>.Defined.Contains(value);
    }

    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static ImmutableArray<TEnum> Values => EnumInfo<TEnum>.Values;
        public static int Count => EnumInfo<TEnum>.Values.Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status
{
    [Description("Not yet published")] Draft,
    [Description("Live")]              Active,
    Archived,
}
```

```
Status.Count      : 3
Status.Values     : [Draft, Active, Archived]
Description       : Not yet published
Description (none): Archived
IsKnown           : True / False
Parse             : Active
TryParse bad input: False
```

辞書を組み立てる部分の `DistinctBy(v => v)` は飾りではありません。`Enum.GetValues` は*メンバー*ごとに 1 エントリを返し、2 つのメンバーが同じ値を共有できる (`Alias = Active`) ため、これがないとキー重複の例外が飛びます。これは enum の永続化を厄介にするのと同じ別名の問題で、[EF Core 11 で enum を文字列として保存する](/ja/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)で扱っています。

`Descriptions` でリフレクションを使っているため、トリミングや Native AOT を有効にして発行する場合、このパターンにはトリミング用の注釈が必要になります。どちらかを対象にするなら `Description` メンバーを落とすか、文字列を source generator から供給してください。

ひとつ境界を明示しておきます。拡張メンバーは、ソースコードに書いた名前に対してコンパイル時に解決されます。enum 型が実行時に `Type` としてしか分からない場合、ここまでの話は一切当てはまらず、非ジェネリックなリフレクション API に戻ることになります。extension ブロックが enum を扱いやすくするのは、自分でコンパイルするコードの中であって、実行時に発見するコードの中ではありません。

## 参考資料

- MS Learn の [Extension member declarations, C# reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension)、2026-08-13 更新
- .NET Blog の [C# 14: Exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/)
- API リファレンス [Enum.GetValues&lt;TEnum&gt;()](https://learn.microsoft.com/en-us/dotnet/api/system.enum.getvalues)
- API リファレンス [FrozenSet&lt;T&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.collections.frozen.frozenset-1)

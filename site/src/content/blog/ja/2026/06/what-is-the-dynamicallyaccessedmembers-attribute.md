---
title: "DynamicallyAccessedMembers 属性とは何ですか?"
description: "DynamicallyAccessedMembers は、リフレクションで到達する Type のメンバーを .NET トリマーと AOT コンパイラーに伝え、トリミングで削除される代わりに保持させます。これにより、サイレントなランタイムの MissingMethodException が、ビルド時の IL2070 警告に変わります。この属性が何をするのか、その背後にあるデータフロー解析がどのように動くのか、そしてパラメーター、フィールド、ジェネリック型パラメーターを正しく注釈する方法を解説します。"
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/06/what-is-the-dynamicallyaccessedmembers-attribute"
translatedBy: "claude"
translationDate: 2026-06-20
---

`[DynamicallyAccessedMembers]` は、`Type`(あるいは型名を表す `string`)に付ける属性で、.NET トリマーと Native AOT コンパイラーに対して「これらのメンバーにリフレクションで到達するので、削除しないでください」と伝えるためのものです。これは、静的解析がそのままでは見えないリフレクションを追跡できるようにする契約です。これがなければ、トリマーは到達可能であると証明できないメンバーをすべて削除し、あなたの `type.GetMethod("Run").Invoke(...)` は、`dotnet run` では動いていたにもかかわらず、公開されたアプリのランタイムで `MissingMethodException` をスローします。これがあれば、同じコードはクリーンにコンパイルされるか、注釈のない `Type` がリフレクション呼び出しに流れ込む正確な箇所を指し示す、的確なビルド時の警告(`IL2070`、`IL2075`、`IL2077` など)を出してくれます。この属性は `System.Diagnostics.CodeAnalysis` にあり、`System.Runtime.dll` で出荷され、.NET 5 以降安定しています。以下の内容はすべて .NET 11 SDK(`11.0.100`)と C# 14 を対象としていますが、その仕組みはトリム解析の警告が初めて出力された .NET 6 以降に当てはまります。

## なぜトリマーにヒントが必要なのか

トリミング、そしてそれを必須とする [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) のビルドは、到達可能性解析によって動作します。トリマーはエントリーポイントから出発し、静的に見えるあらゆるメソッド呼び出し、フィールドアクセス、型参照をたどり、触れたものすべてを「保持」とマークし、残りを削除します。これが、自己完結型アプリが 70 MB から 15 MB に縮小する仕組みです。フレームワークは巨大で、あなたのアプリはそのほんの一部しか使っていません。

リフレクションはこのたどりを断ち切ります。`type.GetMethods()` と書くと、トリマーは `type` がランタイムにどの型を保持しているのか分からないため、どのメソッドを保持すべきか判断できません。トリマーには 2 つの選択肢があります。その呼び出しに流れ込み得るあらゆる型のあらゆるメソッドを保持する(これではトリミングが完全に台無しになります)か、何も保持せずにランタイムで気づかせるかです。トリマーはそのどちらもしません。代わりに、リフレクションを行う BCL のメソッド自体に注釈が付けられており、トリマーはあなたが渡す `Type` がそれに見合った約束を持つことを要求します。`[DynamicallyAccessedMembers]` は、その約束を行うための手段です。

.NET ソースの `Type.GetMethods()` のシグネチャを見ると、このインスタンスメソッドは実質的に `this` に `PublicMethods` を要求するよう注釈されていることが分かります。そのため、この一見無害なヘルパーは警告を生みます。

```csharp
// .NET 11, C# 14. Compiled with <PublishTrimmed>true</PublishTrimmed>.
static void UseMethods(Type type)
{
    // warning IL2070: 'this' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to
    // 'System.Type.GetMethods()'. The parameter 'type' of method
    // 'UseMethods(Type)' does not have matching annotations.
    foreach (var method in type.GetMethods())
    {
        // ...
    }
}
```

トリマーはこう言っています。これから `type` が何であれその public メソッドを列挙させようとしているが、それらのメソッドがトリミングを生き延びると誰も約束していない。`Type` の供給元に注釈を付けて、その約束を型システムに組み込んでください。

## 解決策: パラメーターに要件を明示する

解決策は、`Type` を供給するパラメーターにその要件をコピーすることです。

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var method in type.GetMethods()) // no warning
    {
        // ...
    }
}
```

これで `UseMethods` は内部的に満たされましたが、要件が消えたわけではありません。それは呼び出し元へ移動します。`UseMethods` を呼び出す者は、それ自身が public メソッドを保持すると分かっている `Type` を渡さなければなりません。これがモデルのすべてです。この属性はそれ自体で何かを保持するわけではありません。これは、具体的な型が分かっている地点に到達するまで、責務を呼び出しチェーンの上方へ押し上げるフロー注釈なのです。

## 責務が実際に終わる場所

要件の伝播は 2 つの場所のいずれかで止まります。1 つ目は `typeof` です。`typeof(Customer)` と書くと、トリマーは正確な型を把握し、行き先が要求するものを何であれ保持できます。

```csharp
// .NET 11. typeof gives the trimmer a concrete type, so it keeps
// Customer's public methods and the call is clean.
UseMethods(typeof(Customer));
```

2 つ目は public API の境界です。`Type` がパラメーター、フィールド、メソッドの戻り値から来ている場合、その場所にも注釈を付け、チェーンは外側へと続いていきます。次は、見落とされがちなフィールドのケースです。

```csharp
// .NET 11, C# 14.
static Type _type = typeof(Customer);

static void UseMethodsHelper()
{
    // warning IL2077: 'type' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to 'UseMethods(Type)'.
    // The field '_type' does not have matching annotations.
    UseMethods(_type);
}
```

このフィールドは約束を持たないため、注釈付きのパラメーターに渡すと警告が出ます。フィールドに注釈を付けると、今度はトリマーがそのフィールドへのすべての代入の地点で約束を強制するようになります。

```csharp
// .NET 11, C# 14.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type _type = typeof(Customer); // assignment of a concrete type: clean

static void UseMethodsHelper() => UseMethods(_type); // clean
```

トリマーが推論できないもの(注釈のない `Type` パラメーターや、ランタイムの文字列からの `Type.GetType("…")`)をその注釈付きフィールドに代入すると、その代入箇所で警告が出ます。約束は、今や両方向で意味を持つようになりました。

## DynamicallyAccessedMemberTypes フラグ

唯一のコンストラクター引数は `[Flags]` 列挙型なので、`|` で値を組み合わせ、リフレクションが触れるものだけを過不足なく保持できます。中心となる値とその数値フラグは次のとおりです。

| 値 | 何を保持するか |
| --- | --- |
| `None` | 何も保持しません。 |
| `PublicParameterlessConstructor` | デフォルトの public コンストラクター(`Activator.CreateInstance(type)` が必要とするもの)。 |
| `PublicConstructors` | すべての public コンストラクター。 |
| `NonPublicConstructors` | すべての非 public コンストラクター。 |
| `PublicMethods` / `NonPublicMethods` | public / 非 public メソッド。 |
| `PublicFields` / `NonPublicFields` | public / 非 public フィールド。 |
| `PublicProperties` / `NonPublicProperties` | public / 非 public プロパティ。 |
| `PublicEvents` / `NonPublicEvents` | public / 非 public イベント。 |
| `PublicNestedTypes` / `NonPublicNestedTypes` | ネストされた型。 |
| `Interfaces` | その型が実装するインターフェース。 |
| `All` | すべて(値は `-1`)。 |

ルールは、最小限を要求することです。`Activator.CreateInstance(type)` しか行わないなら、`All` ではなく `PublicParameterlessConstructor` を要求してください。追加するフラグはすべて、トリマーが削除を禁じられるメンバーであり、それは最終的なアプリで支払うバイナリサイズです。`All` は安易な答えであり、その型についてトリミングの利点の大半をひそかに帳消しにします。

.NET 9 と 10 では、`...WithInherited` と `All...` という 2 つ目のファミリーのフラグが追加されました。たとえば `AllMethods`、`AllConstructors`、`NonPublicMethodsWithInherited` です。素の `PublicMethods` フラグは、継承された public メソッドが型の public な表面の一部であるため、すでにそれらを含んでいますが、非 public のバリアントは従来、基底クラスをたどりませんでした。`WithInherited` フラグは、継承された private または protected メンバーをリフレクションで扱う際に、そのギャップを埋めます。リフレクションが実際に継承の境界を越える場合にのみ、これらを使ってください。

## ジェネリック型パラメーターと戻り値への注釈

この属性はパラメーターとフィールドに限定されません。その `AttributeUsage` は、パラメーター、フィールド、プロパティ、戻り値、ジェネリックパラメーター、クラス、インターフェース、構造体、メソッドを対象とします。このうち 2 つは取り上げる価値があります。

ジェネリック型パラメーターは要件を持つことができ、これがトリムセーフを保ったままリフレクションに支えられたファクトリーを書く方法です。

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static T Create<[DynamicallyAccessedMembers(
    DynamicallyAccessedMemberTypes.PublicParameterlessConstructor)] T>()
{
    return Activator.CreateInstance<T>(); // clean
}

// The constraint flows to the call site. typeof is implicit in the type argument.
var c = Create<Customer>(); // trimmer keeps Customer's parameterless ctor
```

この属性をメソッドに適用するのは、ドキュメントに記載された特別なケースです。それは `this` パラメーターに適用されるものとして扱われるため、`Type` に代入可能な型のインスタンスメソッドでのみ意味を持ちます。戻り値ターゲットを使うと、メソッドは返す `Type` について何かを約束できます。

```csharp
// .NET 11, C# 14. The caller can reflect over public methods of the returned Type.
[return: DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type ResolveHandler(string name) =>
    name == "customer" ? typeof(Customer) : typeof(Order);
```

## 本当に注釈を付けられないパターンの場合

データフローが実在し正しいにもかかわらず、アナライザーがそれを追えないことがあります。たとえば、すべての要素がコンストラクターを保持していることを構造上あなたは知っているが、トリマーにはその不変条件が見えない `Type[]` などです。こうした場合、`[UnconditionalSuppressMessage]` は特定の警告を抑制し、`[SuppressMessage]` とは異なり IL に永続化されるため、トリム解析がそれを尊重します。

```csharp
// .NET 11, C# 14.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only ever holds types stored through the annotated setter.")]
get => _types[i];
```

これは、あなたが自らの名誉にかけて行う約束です。ドキュメントは、抑制が有効なのは、リフレクション対象のメンバーがプログラムの他の場所で本物のリフレクションターゲットになっている場合に限られると率直に述べています。なぜなら、可視のリフレクションターゲットでないメンバーは、オプティマイザーによってインライン化、リネーム、移動される可能性があり、抑制したコードはそのとき、いかなる警告も予測しなかった形で壊れるからです。

もう 1 つの脱出口は `[DynamicDependency]` で、これは名前付きのメンバーを保持しますが、解析には情報を伝えません。これは、別のアセンブリから文字列でメンバーを読み込むような、`[DynamicallyAccessedMembers]` でさえ表現できないパターンのための最後の手段です。

```csharp
// .NET 11, C# 14.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

多くの呼び出し箇所でどちらかの脱出口に手を伸ばしている自分に気づいたら、それは、その API が根本的にリフレクションに依存した形をしており、コンパイル時のコード生成に置き換えるべきだというサインです。リフレクションベースのシリアライザーやマッパーがその典型例です。`GetProperties()` のたどりを注釈で回避する代わりに、ビルド時にアクセスコードを生成するソースジェネレーターを採用します。その用語が初めてなら、[ソースジェネレーターとは何か、いつ必要になるか](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)が入門になります。そして、それがソースジェネレーター版の `System.Text.Json` が存在する理由です。

## RequiresUnreferencedCode との関係

`[DynamicallyAccessedMembers]` を `[RequiresUnreferencedCode]` と混同しやすいものです。これらは隣接する問題を解決します。`[DynamicallyAccessedMembers]` は解析可能なリフレクションのためのものです。`Type` のどのメンバーに触れるかを正確に把握しているので、それを明示すればトリマーがそれらを保持します。`[RequiresUnreferencedCode]` は、まったくトリムセーフにできないリフレクションのためのものであり、そのメソッドがトリマーにはモデル化できない何かをしているという表明です。メソッドにこれを注釈しても何も解決しません。それは、ライブラリ作者がその制限を文書化できる public API に警告が到達するまで、`[DynamicallyAccessedMembers]` がその要件を伝播するのと同じように、`IL2026` 警告をすべての呼び出し元へ伝播します。要件を表現できるときは `[DynamicallyAccessedMembers]` を使い、本当にできないときにのみ `[RequiresUnreferencedCode]` にフォールバックしてください。

実践的なワークフローは、トリミングと AOT のストーリー全体を支配するものと同じです。アナライザーをオンにし、すべての `IL2xxx` 警告をノイズではなく本物の欠陥として扱い、出荷する前にその件数をゼロまで減らすことです。ライブラリに `<IsTrimmable>true</IsTrimmable>` を設定すればそのプロジェクトに絞った警告が得られますし、`<PublishTrimmed>true</PublishTrimmed>` と `TrimmerRootAssembly` のエントリーを備えた小さなトリミングテストアプリをビルドすれば、依存グラフ全体にわたるすべての警告を確認できます。クリーンなビルドが契約です。AOT 非互換の呼び出しがアナライザーをすり抜け、ランタイムでのみ失敗するとき、あなたは [Native AOT における PlatformNotSupportedException](/2026/05/fix-platformnotsupportedexception-in-native-aot/) のデバッグに逆戻りします。それこそ、これらの注釈が防ぐために存在しているサイレントな失敗です。そして、これを実際の Web サービスのために組み込んでいるなら、[ASP.NET Core minimal API で Native AOT を使う方法](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)が、クリーンビルドのレシピを端から端まで案内します。

これらすべてが腑に落ちる心構えはこうです。`[DynamicallyAccessedMembers]` はコードを保持しません。それは、リフレクション呼び出しから、その `Type` が生まれた場所まで、`Type` 値のフローに沿って要件を伝播させるものであり、保持が起きるのは要件が最終的に着地する `typeof` または具体的な代入の地点だけです。このフローを正しく把握すれば、トリミングは謎めいた本番限定のクラッシュの源ではなくなり、本当に信頼できるコンパイラー機能になります。

## 関連記事

- [Native AOT とは何か、何を犠牲にするのか?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) では、AOT のもとでなぜトリミングが必須なのか、ほかに何を手放すのかを説明しています。
- [ソースジェネレーターとは何か、いつ必要になるか?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) では、注釈を付けられないリフレクションを置き換えるコンパイル時のコード生成を取り上げています。
- [ASP.NET Core minimal API で Native AOT を使う方法](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、これらの警告が実践でどう現れるかを示すクリーンビルドのウォークスルーです。
- [修正: Native AOT における PlatformNotSupportedException](/2026/05/fix-platformnotsupportedexception-in-native-aot/) は、注釈が付き警告のないビルドが防ぐランタイムの失敗です。

## ソース

- [DynamicallyAccessedMembersAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembersattribute), MS Learn(定義、AttributeUsage のターゲット、メソッドが this になる特別なケース)。
- [DynamicallyAccessedMemberTypes Enum](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembertypes), MS Learn(.NET 9/10 の WithInherited 追加分を含む、フラグの完全な一覧)。
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn(IL2070/IL2077 の例、UnconditionalSuppressMessage、DynamicDependency、推奨事項)。
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn(警告のカタログとデータフローモデル)。

---
title: "ソースジェネレーターとは何か、いつ必要になるのか?"
description: "C# のソースジェネレーターについてのわかりやすいガイドです。実際に何をするのか、IIncrementalGenerator のパイプラインがどう動くのか、リフレクションや T4 より優れるのはどんなときか、そして使うべきでないケースまで解説します。.NET 11 と C# 14 で動く例つきです。"
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "source-generators"
  - "roslyn"
lang: "ja"
translationOf: "2026/06/what-is-a-source-generator-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-06-19
---

ソースジェネレーターとは、C# コンパイラーがプロジェクトをコンパイルしている最中に実行するコード片で、あなたのコードを読み取り、同じコンパイルに新しい C# ファイルを追加できるものです。コンパイル時に動作し、あなた自身が書いたかのようにコンパイラーがその後コンパイルする通常のソースコードを生成し、生成されたコード自体を超えるランタイムコストは一切加えません。必要になるのは、そうしなければランタイムでリフレクションの代償を払う、繰り返しの多いボイラープレートを手書きする、あるいはビルドの外で別個のコード生成ステップを実行することになり、かつ生成されたコードに強い型付け、デバッグのしやすさ、トリミング対応、Native AOT 適合性を求めるときです。これらの問題のいずれもなければ、ほぼ確実にジェネレーターを書く必要はありません。このガイドは .NET 11 (preview 5) と C# 14 を対象としますが、仕組みは .NET 6 以降のあらゆるプロジェクトに当てはまります。

## 「コンパイラーの中で動く」とは実際どういうことか

あなたが書くコードのほとんどは、ビルドの後、アプリケーションの起動時に動きます。ソースジェネレーターは違います。コンパイラーがアナライザーとして読み込み、コンパイル中に呼び出す Roslyn のコンポーネントです。その時点までに Roslyn がプロジェクトについて知っているすべて (構文ツリー、セマンティックなシンボル、参照、追加ファイル) への読み取り専用のビューを得て、その唯一の出力はさらなるソースコードです。既存のファイルを書き換えたり、コードを削除したり、すでに書いたものを変更したりはできません。追加することしかできません。

この「追加するだけ」という制約が設計のすべてです。生成されたコードは追加ファイルとしてコンパイルに入り、最も一般的なパターンは `partial` メンバーです。クラスの半分を手書きし、`partial` を付け、ジェネレーターがもう半分を生成します。両方の半分は 1 つの型としてまとめてコンパイルされます。出力は本物の IL になる本物の C# なので、下流のすべてはそれをあなたが書いたコードとして扱います。IntelliSense はそれを認識し、デバッガーはそこへステップインし、リンカーはそれをトリミングでき、Native AOT は事前にコンパイルできます。ランタイムのリフレクションも、`Reflection.Emit` も、動的プロキシもありません。

これが鍵となるメンタルモデルです。ソースジェネレーターはマクロシステムでもビルド後スクリプトでもありません。「あなたのコード」から「さらなるあなたのコード」へのコンパイル時の関数です。

## なぜ置き換える対象の代替手段より優れるのか

ソースジェネレーター (.NET 5、Roslyn 3.8 で導入) 以前、ボイラープレートを手書きせずに済ませる方法は 3 つありました。リフレクション、IL のエミット、そして T4 テンプレートのような外部コードジェネレーターです。それぞれに、ソースジェネレーターが取り除く実際のコストがあります。

ランタイムのリフレクション (従来の JSON シリアライザー、依存性注入のコンテナー、オブジェクトマッパーを思い浮かべてください) は起動時に型を調べ、呼び出しごとに解釈するか、動的メソッドを一度組み立ててキャッシュするかのいずれかです。動きはしますが、起動の税を払い、トリマーからは見えず (そのためトリミングや AOT のビルドを肥大化させるか、丸ごと壊します)、コストはあなたのビルドではなくユーザーに降りかかります。リフレクションからの `System.InvalidOperationException` や `System.PlatformNotSupportedException` はランタイムでしか現れず、しばしば本番で発生します。まさにこの障害モードを [リフレクション中心のコードが Native AOT で壊れる理由](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) で扱いました。

T4 やその他の外部ジェネレーターは別個のステップとして動き、たいていは独自のツールでビルドに組み込まれます。セマンティックモデルを見ることができず (シンボルではなくテキストをパースします)、生成されたファイルはディスク上に残って同期がずれ、CI では扱いにくいものです。ソースジェネレーターは同じコンパイルの中で動き、完全に解決されたシンボルを見て、古くなったファイルをリポジトリに書き込むことは決してありません。

ソースジェネレーターはこの作業をすべてコンパイル時に移し、素の、静的にコンパイルされた C# を生成します。シリアライザーは起動時にあなたの型をリフレクションせず、それを読み書きする正確なコードをすでに持っています。だからこそ `System.Text.Json` の組み込みソースジェネレーターは Native AOT で動作する唯一の JSON の道なのです。これは [2026 年における System.Text.Json と Newtonsoft.Json](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) でも指摘した点です。

## すでに使っているジェネレーター

この概念の恩恵を受けるのに自分で書く必要はありません。現代の .NET はいくつも同梱しており、それらに気づくと、ジェネレーターがどんな種類の問題に向いているかがわかります。

- `System.Text.Json` のソース生成 (`[JsonSerializable]` + `JsonSerializerContext`) はシリアライズのコードを生成し、STJ がランタイムでリフレクションしないようにします。
- `LoggerMessage` のソース生成 (`[LoggerMessage]`) は部分メソッドを、アロケーションなしで強く型付けされたログ呼び出しに変えます。
- `GeneratedRegex` (`[GeneratedRegex]`) は初回利用時に状態マシンを組み立てる代わりに、正規表現パターンをコンパイル時に C# へコンパイルします。
- `System.Text.Json`、`Microsoft.Extensions.Configuration`、オプションのバインダーには、リフレクションベースのバインディングを置き換えるジェネレーターがあります。
- `CommunityToolkit.Mvvm` は `[ObservableProperty]` から `INotifyPropertyChanged` の配管を生成します。
- `Mapperly` はオブジェクト間のマッピングをコンパイル時に生成します。これは私たちの [AutoMapper からソース生成マッピングへの移行](/ja/2026/05/migrate-from-automapper-to-source-generated-mapping/) の土台です。

共通の形はこうです。宣言的なマーカー (属性、部分メソッド、部分クラス) を取り、さもなければ手書きされるか、ランタイムで割り出されるであろう、退屈でエラーを招きやすい、リフレクションのような形のコードを生成します。

## ジェネレーターの作り方: インクリメンタルなパイプライン

ジェネレーターのインターフェースは 2 つあり、現行は 1 つだけです。元の `ISourceGenerator` (コンパイル全体を受け取り、キーを打つたびに動く `Initialize`/`Execute` の組) は非推奨です。Roslyn のソースは明示的にこう述べています。"ISourceGenerator is deprecated and should not be implemented. Please implement IIncrementalGenerator instead." ([dotnet/roslyn の ISourceGenerator 非推奨に関する注記](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs) を参照)。新しいものには `IIncrementalGenerator` を使ってください。

理由は IDE でのパフォーマンスです。インクリメンタルなジェネレーターは実行のたびにすべてをゼロから計算しません。パイプライン、すなわち変換ステップのグラフを宣言し、Roslyn は各ステップの出力をキャッシュします。あるステップの入力が前回のキー入力以降変わっていなければ、Roslyn はそのステップを飛ばしてキャッシュされた結果を再利用します。これにより、入力中にジェネレーターを 1 分間に何百回も再実行しても安全になります。

以下は最小ながら完全なジェネレーターです。`[AutoToString]` が付いたクラスを見つけ、public なプロパティを列挙する `ToString()` のオーバーライドを生成します。

```csharp
// Generator project: netstandard2.0, references Microsoft.CodeAnalysis.CSharp
// .NET 11 preview 5, Roslyn 4.x, C# 14
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

[Generator]
public sealed class AutoToStringGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        // 1. Cheap syntactic filter, then a semantic transform into a small,
        //    value-equatable model. Returning a record (not a symbol) is what
        //    lets Roslyn cache this step and skip work when nothing changed.
        var classes = context.SyntaxProvider.ForAttributeWithMetadataName(
            "AutoToStringAttribute",
            predicate: static (node, _) => node is ClassDeclarationSyntax,
            transform: static (ctx, _) =>
            {
                var symbol = (INamedTypeSymbol)ctx.TargetSymbol;
                var props = symbol.GetMembers()
                    .OfType<IPropertySymbol>()
                    .Where(p => p.DeclaredAccessibility == Accessibility.Public)
                    .Select(p => p.Name)
                    .ToImmutableArray();
                return new Model(symbol.ContainingNamespace.ToDisplayString(),
                                 symbol.Name, props);
            });

        // 2. Emit one source file per matched class.
        context.RegisterSourceOutput(classes, static (spc, model) =>
        {
            var sb = new StringBuilder();
            sb.AppendLine($"namespace {model.Namespace};");
            sb.AppendLine($"partial class {model.Name}");
            sb.AppendLine("{");
            sb.AppendLine("    public override string ToString() =>");
            var body = string.Join(" + \", \" + ",
                model.Properties.Select(p => $"\"{p}=\" + {p}"));
            sb.AppendLine($"        {body};");
            sb.AppendLine("}");
            spc.AddSource($"{model.Name}.AutoToString.g.cs", sb.ToString());
        });
    }

    private record Model(string Namespace, string Name,
                         ImmutableArray<string> Properties);
}
```

消費側は属性と `partial class` だけです。

```csharp
// Consumer project, C# 14
[AutoToString]
public partial class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
}

// Elsewhere: new Order { Id = 7, Customer = "Acme" }.ToString()
// => "Id=7, Customer=Acme"   (the ToString override is generated)
```

ほとんどの重みを担うのは 2 つの細部です。第一に、`ForAttributeWithMetadataName` は Roslyn 4.3 で追加された高速な入口です。あらゆる構文ノードを巡る代わりに、実際にあなたの属性を持つノードへ Roslyn が事前にフィルターできるようにします。これは実際のジェネレーターで最大のパフォーマンスの梃子です。第二に、`transform` は `INamedTypeSymbol` ではなく小さな `record` (`Model`) を返します。これは見た目以上に重要です。インクリメンタル性は値の等価性に依存します。Roslyn の cookbook が言うように、`record`、`struct`、タプル、`ImmutableArray<T>` といった値で等価比較できる型をパイプラインに流したいのです。なぜなら、あるステップが前回の出力と等しい値を返した瞬間に、Roslyn は止まって下流のキャッシュ結果を再利用するからです。`Symbol` や `Compilation` をパイプラインに通すと、キャッシュは完全に台無しになります。これらの型は大きく、参照で等価比較され、キーを打つたびに変わるからです。

## いつ手を伸ばすべきか

以下のすべてが当てはまるとき、ソースジェネレーターを書くか採用してください。

1. コードが機械的で、ソースにすでにあるもの (型の形、属性、メソッドのシグネチャ) から導けること。人が書いても書き写すだけなら、ジェネレーターにできます。
2. 現在それをランタイムのリフレクションで支払っていて、そのコストが現実のものであること。起動レイテンシ、ホットパスでのアロケーション、あるいはトリミング/AOT との非互換です。
3. 結果がデバッグ可能で静的に型付けされていてほしいこと。ステップインできない動的メソッドではなく。

最も明確な勝ち筋は、シリアライズ、DTO のマッピング、依存性注入の登録、`INotifyPropertyChanged`、強く型付けされた構成バインディング、契約からのクライアント生成、そして `Activator.CreateInstance` や `Expression.Compile` を使うあらゆるホットパスの置き換えです。Native AOT を狙うなら、計算はさらにジェネレーター寄りに傾きます。リフレクションベースの手法こそ、そこで壊れるものだからです。この制約は [ASP.NET Core minimal API で Native AOT を使う](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) でたどりました。

## いつ不要か (そして書くべきでないか)

ジェネレーターは作るのも保守するのもタダではありません。次のときは自作を見送ってください。

- すでに十分にテストされたジェネレーターが存在するとき。`CommunityToolkit.Mvvm`、Mapperly、STJ のコンテキストジェネレーターを趣味で再実装しないでください。使いましょう。[INotifyPropertyChanged ジェネレーターの手引き](/ja/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) は Roslyn の API を教えるためにあり、あなたが自前の MVVM ツールキットを出すべきだと主張するためのものではありません。
- 繰り返しが小さい、または一度きりのとき。似たクラスがひと握りあるくらいは、`netstandard2.0` のアナライザープロジェクト、別個のテストハーネス、そして 2 つ目のコンパイラーをアタッチするデバッグの段取りを抱え込む理由になりません。
- 実際には既存のコードを変換または書き換える必要があるとき。ジェネレーターは追加しかできません。書いていないメソッドに振る舞いを差し込みたいなら、それはインターセプター (C# 14 の別機能) か、Fody のようなコンパイル後の IL ウィーバーであって、ソースジェネレーターではありません。
- 形が本当に動的で、コンパイラーには見えないデータ (起動時に読む構成ファイル、ディスクから読み込むプラグイン) からランタイムで決まるとき。コンパイラーはランタイムの状態を何も知らないので、ジェネレーターは役に立ちません。
- 単純なジェネリック `T`、基底クラス、または素のヘルパーメソッドで足りるとき。まず言語に手を伸ばしてください。ジェネレーターは、言語が型ごとのボイラープレートなしには抽象を表現できない場合のためのものです。

多くのチームにとっての正直な既定値はこうです。ジェネレーターは気前よく使い、自作はめったにしないこと。

## 最初につまずく落とし穴

最初の一回は誰もがつまずく点がいくつかあります。

- ジェネレーターのプロジェクトは `netstandard2.0` を対象にしなければなりません。アプリが何を対象にしていようと、これはアナライザーに対して Roslyn が要求する契約のままです。出力するコードよりも古い言語の地平でジェネレーターを書くことになります。
- 通常の依存ではなくアナライザーとして参照してください。`<ProjectReference Include="..\Gen.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" />`。ここを誤ると、ジェネレーターが動かないか、ランタイムの出力に紛れ込みます。
- 生成されたコードは追加的で、既定では見えません。消費側のプロジェクトに `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` を設定し、`obj/` の下に `.g.cs` ファイルを書き出せば、実際に何が生成されたかを読めます。出力がおかしいときに最初にやることです。
- `Compilation`、`ISymbol`、`SyntaxNode` をパイプラインのデータモデルに入れないでください。これらは値で等価比較できず、インクリメンタル性を殺し、避けようとしていた遅い `ISourceGenerator` の挙動へジェネレーターを戻してしまいます。早めに record へ射影してください。
- ジェネレーターから決して例外を投げないでください。例外はビルドの警告 (`CS8785`) になり、あなたのコードは黙って生成されません。「属性はあるが型が壊れている」ケースは、クラッシュではなく診断を出して扱ってください。
- ジェネレーターは消費側プロジェクトのビルドごと、IDE では編集ごとに動きます。遅い、あるいはインクリメンタルでないジェネレーターは、エディター全体をもっさりさせます。これは理屈ではありません。インクリメンタルな API が存在する理由そのものです。

トラブルを避ける思考のショートカットはこうです。ソースジェネレーターは、不変の入力からソーステキストへの、純粋でキャッシュされる関数です。入力を小さく値で等価比較できるものに保ち、関数を速く保ち、決して例外を投げさせず、リフレクションや手書きのボイラープレートが測れる何かを消費しているときにだけ書いてください。

## 出典とさらに読むための資料

- [インクリメンタルジェネレーター、dotnet/roslyn のドキュメント](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.md)
- [インクリメンタルジェネレーターの cookbook、dotnet/roslyn](https://github.com/dotnet/roslyn/blob/main/docs/features/incremental-generators.cookbook.md)
- [ISourceGenerator 非推奨に関する注記、dotnet/roslyn のソース](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/ISourceGenerator.cs)
- [ソースジェネレーターの概要、Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview)

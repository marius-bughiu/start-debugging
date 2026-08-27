---
title: "Blazor コンポーネントで見出しレベル (h1-h6) を実行時に決めてレンダリングする方法"
description: "Razor にはタグ名を変数にする構文がなく、DynamicComponent はコンポーネント型しかレンダリングできません。BuildRenderTree をオーバーライドして builder.OpenElement(0, $\"h{level}\") を呼び出します。属性の受け渡し、タグ名を DOM に渡す前に範囲制限すべき理由、レベルを変えると @key を付けても要素が DOM から作り直される理由、カスケード値による自動レベル付けまで解説します。"
pubDate: 2026-08-27
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-render-a-heading-with-a-runtime-chosen-level-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-27
---

Razor には `<h@Level>` と書く手段がなく、`<DynamicComponent>` も `Type` パラメーターが `IComponent` を実装している必要があるため役に立ちません。答えは `RenderTreeBuilder` まで降りて要素を自分で組み立てることです。`BuildRenderTree` をオーバーライドし、あらかじめ 1 から 6 に制限したレベルを使って `builder.OpenElement(0, $"h{level}")` を呼び出します。以下の内容はすべて .NET 10 (SDK 10.0.201、`Microsoft.AspNetCore.App` 10.0.5) で検証しました。これらの API は .NET 11 のプレビューでも変わっていません。

## 思いつきやすい 2 つの方法がうまくいかない理由

最初に思い浮かぶのは `<DynamicComponent Type="...">` でしょう。しかしこの用途には使えません。ドキュメントはこれを「型によってコンポーネントをレンダリングする」手段だと説明しており、ランタイムもそれを強制します。要素名や、コンポーネントでない型を渡すと、何もレンダリングされる前に例外が発生します。

```text
System.ArgumentException: The component type must implement Microsoft.AspNetCore.Components.IComponent.
```

HTML 要素に相当するものは存在しません。`DynamicComponent` は `RocketLab.razor` と `SpaceX.razor` のどちらを使うかを選ぶためのものであり、`h2` と `h3` を選ぶためのものではありません。

次に思いつくのは、タグを 2 つの `MarkupString` に分割する方法です。

```csharp
// .NET 10. Renders correctly in static SSR and breaks interactively.
builder.AddContent(0, (MarkupString)$"<h{Level}>");
builder.AddContent(1, ChildContent);
builder.AddContent(2, (MarkupString)$"</h{Level}>");
```

これは理解しておく価値のある落とし穴です。動いているように見えてしまうからです。静的サーバーサイドレンダリング用に `HtmlRenderer` を通すと、出力はまったく正しく見えます。

```html
<h3>Release notes</h3>
```

これは静的 SSR がフレームを文字列として連結しているから起きているにすぎません。レンダーツリーを調べると、実際に生成されたものが分かります。子を持つ 1 つの要素ではなく、独立した 3 つの兄弟フレームです。

```text
PrependFrame @sibling 0 frame=[Markup "<h3>"]
PrependFrame @sibling 1 frame=[Text "Release notes"]
PrependFrame @sibling 2 frame=[Markup "</h3>"]
```

Blazor Server や WebAssembly では、クライアントがこれらのフレームをたどり、マークアップフレームごとに `insertMarkup` を呼び出します。そして [`insertMarkup` は各フレームの内容を個別にパースしてから](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts)、できあがったノードを挿入します。ブラウザーのパーサーは単独の文字列 `<h3>` を空の `<h3></h3>` 要素に変え、単独の文字列 `</h3>` は何にもなりません。結果としてテキストは空の見出しの*後ろ*にある兄弟ノードになります。このコンポーネントは静的 SSR での簡単な確認をすり抜け、レンダリングモードがインタラクティブになった途端に、壊れたアクセシビリティの低いマークアップを出力します。

6 分岐をベタ書きした `@switch` は確かに動きます。ただし、すべての属性、すべての CSS クラス、子コンテンツが 6 つに複製され、それらを永久に同期させ続ける必要があります。コンポーネント 1 つなら許容できますが、見出し、ラベル、セクションタイトルを抱えるデザインシステムでは通用しません。

## 手順: 自分でタグを選ぶ Heading コンポーネントを作る

1. `.razor` ファイルではなく、通常の `.cs` ファイルを作成します。Razor コンポーネントはすでに `BuildRenderTree` メソッドを生成しているため、`@code` ブロックで自前のものを宣言すると `CS0111: Type 'Heading' already defines a member called 'BuildRenderTree' with the same parameter types` が発生します。
2. `ComponentBase` を継承し、`int Level` パラメーター、`RenderFragment? ChildContent` パラメーター、そして `[Parameter(CaptureUnmatchedValues = true)]` を付けた `AdditionalAttributes` ディクショナリを追加します。これで呼び出し側は引き続き `class`、`id`、`data-` 属性を渡せます。
3. `BuildRenderTree` をオーバーライドし、タグ名に埋め込む前に `Math.Clamp(Level, 1, 6)` でレベルを制限します。この制限は利便性ではなくセキュリティ上の対策です。
4. `builder.OpenElement(0, $"h{level}")` を呼び、次に `builder.AddMultipleAttributes(1, AdditionalAttributes)`、次に `builder.AddContent(2, ChildContent)`、最後に `builder.CloseElement()` を呼びます。
5. シーケンス番号はすべて整数リテラルで固定します。一見無害に見えるものであっても、カウンター変数は使わないでください。

## コンポーネントの全体像

```csharp
// Heading.cs -- .NET 10, C# 14
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

public class Heading : ComponentBase
{
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        var level = Math.Clamp(Level, 1, 6);

        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
}
```

使い方は他のコンポーネントとまったく同じです。

```razor
@* .NET 10 *@
<Heading Level="SectionDepth" class="title" id="release-notes">
    Release notes
</Heading>
```

`HtmlRenderer` を通した結果は、手で書いたであろうものと一致します。

```text
Level= 1 -> <h1 class="title" id="s1">Release notes</h1>
Level= 3 -> <h3 class="title" id="s1">Release notes</h3>
Level= 6 -> <h6 class="title" id="s1">Release notes</h6>
Level= 9 -> <h6 class="title" id="s1">Release notes</h6>
Level=-4 -> <h1 class="title" id="s1">Release notes</h1>
```

`AddMultipleAttributes` が `AddContent` より前にある点に注意してください。ある要素の属性フレームは、子コンテンツより前にすべて追加する必要があります。順序を混ぜるとレンダリング時に例外が発生します。

## .razor ファイルのまま書きたい場合

Razor から離れたくない場合も、`BuildRenderTree` をオーバーライドしない限りは可能です。ビルダーのロジックを `RenderFragment` プロパティとして公開し、それをコンポーネントの本体全体としてレンダリングします。

```razor
@* Heading.razor -- .NET 10 *@
@Rendered

@code {
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private RenderFragment Rendered => builder =>
    {
        builder.OpenElement(0, $"h{Math.Clamp(Level, 1, 6)}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    };
}
```

これは問題なくコンパイルされ、前後に余分な空白ノードを作らずに `<h4 class="title">Release notes</h4>` を出力します。`@Rendered` 式がコンポーネント唯一のマークアップだからです。生成された `BuildRenderTree` はあなたのフラグメントを呼び出すだけです。チームがよく grep するほうのファイル形式を選んでください。レンダーツリーはどちらも同一です。

## タグ名はそのまま DOM に届く

手順 3 の範囲制限は、多くの人が省略する部分であり、そして最も重要な部分です。`OpenElement` は `elementName` 引数を検証もエスケープもしません。渡した文字列はそのままタグ名として出力に書き込まれます。検証しない `string Level` パラメーターを持つコンポーネントを、3 種類の入力でレンダリングした結果が次のものです。

```text
Level="2"                          -> <h2>hi</h2>
Level="2 onload=alert(1)"          -> <h2 onload=alert(1)>hi</h2 onload=alert(1)>
Level="2><script>alert(1)</script" -> <h2><script>alert(1)</script>hi</h2><script>alert(1)</script>
```

コンポーネントのパラメーター由来で script タグがページに入り込んでいます。Blazor の自動エンコードはテキストと属性の*値*を守りますが、タグ名は守りません。タグ名がユーザーデータになることは想定されていないからです。Microsoft 自身の `RenderTreeBuilder` に関するガイダンスもそう述べています。不正な形式のコンポーネントは「未定義の動作を引き起こす可能性がある」とされ、そこには「セキュリティの侵害」が含まれます。

したがって、信頼できない値、あるいは単に未検証の値を `OpenElement` に到達させてはいけません。`string` ではなく `int` を受け取って制限し、API の都合でどうしても文字列が必要な場合は、埋め込むのではなく 6 つの見出し名の許可リストに対して検証してください。

## レベルを変えると要素は破棄されて作り直される

Blazor の差分アルゴリズムは、シーケンス番号とフレーム種別でフレームを対応付けます。同じシーケンス番号でもタグ名が*異なる* 2 つの要素フレームは同一の要素とはみなされないため、古いものが削除され、新しいものが挿入されます。`Level` が 2 から 3 に変わったときのレンダーバッチを捕捉すると、まさにそれが確認できます。

```text
after Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

`class` 属性だけを変えた場合と比べてみてください。こちらはその場でパッチが当たります。

```text
after class change only:
  SetAttribute @sibling 0 frame=[Attribute class=subtitle]
```

実務上の影響として、レベルが変わる見出しは DOM ノードを失います。その内部のフォーカスは外れ、捕捉していた `ElementReference` は無効になり、CSS トランジションは再開し、そのノードに紐づいていたサードパーティのスクリプトは切り離されたノードを掴んだままになります。`@key` を付けても救われません。キーは並べ替えをまたいで要素を対応付けるためのものであり、異なる 2 つのタグ名を同じ要素にするものではありません。キー付きのバージョンでも、まったく同じ編集スクリプトが生成されます。

```text
keyed, Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

見出しのレベルはセクションの生存期間中ずっと固定であることがほとんどなので、これが問題になることはめったにありません。問題になるのは、ユーザーがノードを展開するたびに番号が振り直される折りたたみ式のアウトラインなど、頻繁に変わる値からレベルを導出している場合です。そうなったときは、レベルは固定したままスタイルのほうを変えてください。

## シーケンス番号は分岐をまたいでも固定のまま

これは 2 つ目のコードパスを追加した途端に破りやすいルールです。特に `if`/`else` を含むコンポーネントでは、`var seq = 0;` と書いて至るところで `seq++` を使いたくなります。やめてください。Microsoft のドキュメントは明確に「シーケンス番号を動的に生成するとアプリのパフォーマンスが低下する」と述べています。カウンターを使うと、差分アルゴリズムがどの分岐にいたかを判別するための情報が失われるからです。結果として編集スクリプトは長くなり、入れ子構造ではさらに深い再帰的な差分計算が発生します。

正しいパターンは Razor コンパイラー自身が出力しているものと同じです。*ソースコード*の順に増えるリテラル値を使い、各分岐が自分専用の範囲を持ちます。

```csharp
// AutoHeading.cs -- .NET 10, C# 14
protected override void BuildRenderTree(RenderTreeBuilder builder)
{
    var level = Ambient?.Value ?? 1;

    if (level <= 6)
    {
        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
    else
    {
        builder.OpenElement(3, "div");
        builder.AddAttribute(4, "role", "heading");
        builder.AddAttribute(5, "aria-level", level);
        builder.AddMultipleAttributes(6, AdditionalAttributes);
        builder.AddContent(7, ChildContent);
        builder.CloseElement();
    }
}
```

ビルダー呼び出しが 1 画面に収まらないほどコンポーネントが大きくなったら、各部分を `OpenRegion`/`CloseRegion` で囲んでください。リージョンごとに独立したシーケンス番号空間が与えられるので、差分計算を混乱させることなく、その内部でゼロから振り直せます。

## カスケード値による自動レベル付け

上のバージョンは、このコンポーネントのより有用な形を示唆しています。呼び出し側すべてに正しい数値を渡させるのではなく、見出し自身にコンテキストから深さを読み取らせるのです。小さなカスケード値が現在のレベルを運び、入れ子のセクションを開くコンポーネントが次のレベルを下に流します。

```csharp
// HeadingLevel.cs -- .NET 10, C# 14
public sealed class HeadingLevel
{
    public int Value { get; init; } = 1;
    public HeadingLevel Next() => new() { Value = Value + 1 };
}
```

```razor
@* Section.razor -- .NET 10 *@
<CascadingValue Value="_child" IsFixed="true">
    <section>@ChildContent</section>
</CascadingValue>

@code {
    [CascadingParameter] public HeadingLevel? Ambient { get; set; }
    [Parameter] public RenderFragment? ChildContent { get; set; }

    private HeadingLevel _child = default!;

    protected override void OnParametersSet()
        => _child = (Ambient ?? new HeadingLevel()).Next();
}
```

こうすると `AutoHeading` は `Level` パラメーターをまったく受け取らなくなります。セクション 3 階層分の深さに置かれたカードコンポーネントは、自分がどこで使われたかを一切知らないまま `h4` をレンダリングします。この性質こそが、再利用可能なコンポーネントを組み合わせ可能にしているものです。セクションのレンダリング後にレベルが変わらないと分かっている場合は `CascadingValue` に `IsFixed="true"` を指定してください。すべての子孫を変更通知の購読対象にする処理を Blazor が省略できます。

## h6 を超えたときの扱い

HTML は `h6` で止まりますが、深く入れ子になったアウトラインは止まりません。黙って上限で丸めて、支援技術が同列として読み上げてしまう `h6` 要素を 3 つ並べるのではなく、ARIA の同等表現にフォールバックしてください。`role="heading"` と `aria-level` の組み合わせなら、どんな深さでも表現できます。

```text
ambient=2 -> <h2 class="title">Release notes</h2>
ambient=6 -> <h6 class="title">Release notes</h6>
ambient=7 -> <div role="heading" aria-level="7" class="title">Release notes</div>
```

ネイティブ要素が存在する範囲ではそちらのほうが望ましいので、レベル 1 から 6 には本物の `h1`-`h6` タグを使い、ARIA によるフォールバックはあふれた場合のためだけに取っておきます。実際のところ、レベル 7 が必要になるのはページ構造をもっと平坦にすべきサインであることが多いので、フォールバックが発動したら開発時に警告をログ出力しておくとよいでしょう。

最後にレンダーツリーの型そのものについて一言です。ドキュメントは `Microsoft.AspNetCore.Components.RenderTree` 配下のすべてを、不安定なフレームワーク内部として扱うよう明記しています。`RenderTreeBuilder` と `ComponentBase.BuildRenderTree` は公開されたサポート対象の API であり、安心して使えます。上で差分出力を捕捉するために行ったような `RenderBatch` や `RenderTreeEdit` の読み取りは、診断目的であれば問題ありませんが、本番コードに載せるものではありません。

## 関連記事

- 変数のタグ名がそもそも書けない原因は Razor コンパイラーのタグ解決にあり、それは [Blazor で予期しない名前のマークアップ要素が見つかった](/ja/2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor/) のエラーの背後にあるものと同じです。
- DOM に触れるコンポーネントコードはレンダリングモードの境界を守る必要があります。詳しくは [現時点では JavaScript の相互運用呼び出しを発行できません](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) をご覧ください。
- フレームワークがネイティブにできることに JS を持ち出さないという同じ発想は、[JavaScript の相互運用なしで Blazor コンポーネントからファイルをダウンロードする](/ja/2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop/) にも当てはまります。
- 見出しの再構築によって失いたくない状態が消えている場合は、[静的レンダリングからインタラクティブレンダリングへの境界をまたいで状態を保持する](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) がその仕組みを解説しています。
- 選んだレンダリングモードによって、上記の `MarkupString` のバグに到達しうるかどうかが決まります。[Blazor Server vs WebAssembly vs United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) を参照してください。

## 参考資料

- [ASP.NET Core Blazor の高度なシナリオ (レンダーツリーの構築)](https://learn.microsoft.com/en-us/aspnet/core/blazor/advanced-scenarios?view=aspnetcore-10.0)。シーケンス番号に関するガイダンスと、不正な形式のコンポーネントに対するセキュリティ警告を含みます。
- [ASP.NET Core の動的にレンダリングされる Razor コンポーネント](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/dynamiccomponent?view=aspnetcore-10.0)。`DynamicComponent` の契約について。
- [`RenderTreeBuilder.OpenElement` API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendering.rendertreebuilder.openelement)。
- [dotnet/aspnetcore の `BrowserRenderer.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts)。クライアント側でマークアップフレームがどうパースされ挿入されるかについて。

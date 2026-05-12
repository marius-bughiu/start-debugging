---
title: "Fix: Blazor の RZ10012: Found markup element with unexpected name"
description: "Blazor の Razor コンパイラーは、PascalCase のタグに対応するコンポーネント型がスコープ内に見つからないと RZ10012 を出力します。_Imports.razor にコンポーネントの名前空間の @using を追加するか、コンポーネントに @namespace を追加してから再ビルドしてください。"
pubDate: 2026-05-12
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "razor"
lang: "ja"
translationOf: "2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor"
translatedBy: "claude"
translationDate: 2026-05-12
---

修正方法: Razor コンパイラーが PascalCase のタグ (たとえば `<NavMenu />` や `<MudButton />`) を見つけましたが、そのファイルのスコープ内のコンポーネント型に紐付けられませんでした。`@using <namespace>` を親の `.razor` ファイル、またはそれをカバーする `_Imports.razor` のどちらかに追加して、再ビルドしてください。コンポーネントが Razor Class Library (RCL) にあり、フォルダー構造が名前空間と一致しない場合は、コンポーネントの `.razor` ファイルにも `@namespace <FullNamespace>` を追加します。クリーンビルド後も IDE に警告が残る場合は `bin/`、`obj/`、`.vs/` を削除してください。

```text
RZ10012: Found markup element with unexpected name 'NavMenu'.
If this is intended to be a component, add a @using directive for its namespace.
```

このガイドは .NET 11 preview 4、`Microsoft.AspNetCore.App` 11.0.0-preview.4 に同梱される Razor SDK、Visual Studio 17.13 を対象に書かれています。診断 ID `RZ10012` と正確な文言は .NET Core 3.1 以降安定しているため、以下の修正は .NET 6、7、8、10、11 に変更なしで適用できます。Blazor Server、Blazor WebAssembly、Blazor United、Razor Class Library はすべて同じコンパイラーパスからこの診断を出します。

RZ10012 はデフォルトで**コンパイラー警告**であり、エラーではありません。プロジェクトは引き続きビルドできます。タグが本当にコンポーネントを意図しているのに修正せずにデプロイすると、ランタイムはタグを**生の HTML** として描画し (子要素のない `<NavMenu></NavMenu>` 要素になります)、クリックハンドラーは接続されず、パラメーターは静かに消えます。だからこそ、この記事の残りの部分ではこれをビルドをブロックする価値のあるエラーとして扱います。

## Razor コンパイラーがタグを「unexpected」と判断する理由

Razor コンパイラーは `.razor` ファイル内のすべての要素を 1 つのルールで分類します。名前が**大文字の ASCII 文字**で始まるタグはコンポーネント参照、それ以外は HTML です。`<NavMenu />` を見ると、現在のファイルの**タグヘルパーディスクリプター**テーブルを走査し、短い名前が一致し、かつそのファイルに適用される `@using` ディレクティブによって名前空間がインポートされているコンポーネント型を探します。

どのディスクリプターも一致しない場合、コンパイラーには 2 つの選択肢があります。HTML として扱って警告を出し、人間に修正させるか、ビルドを失敗させるかです。設計者は前者を選んだので、RZ10012 は警告です。ディスクリプターテーブルは次の 3 つのソースから次の順で構築されます:

1. **ファイル自身の `@using` ディレクティブ。** レキシカルスコープで、宣言したファイルのみ。
2. **`_Imports.razor` ファイル**、フォルダーごとに**下から上へ**適用されます。ファイルの隣にある `_Imports.razor` が最初に適用され、次に親フォルダーのもの、というようにプロジェクトのルートまでさかのぼります。
3. **プロジェクト全体のインポート**。SDK が注入します: `Microsoft.AspNetCore.Components`、`Microsoft.AspNetCore.Components.Web` など。`<EditForm>` を手動でインポートする必要がないのはこのためです。

`_Imports.razor` は**プロジェクト間で推移的ではない**ことに注意してください。Razor Class Library 内の `_Imports.razor` は、そのライブラリを使用するアプリケーションには流れ込みません。`<MyRclComponent />` を紐付けるには、利用側自身の `_Imports.razor` (またはページ自身) が `@using MyRcl` を宣言する必要があります。

## 再現する最小のファイル

最小の再現は同じプロジェクト内の 2 つのファイルです:

```razor
@* .NET 11 preview 4, Razor SDK 11.0.0-preview.4 *@
@* File: Components/Pages/Home.razor *@

<h1>Home</h1>
<NavMenu />
```

```razor
@* File: Components/Layout/NavMenu.razor *@

<nav>Navigation here</nav>
```

`NavMenu` は `MyApp.Components.Layout` にあります。`Home.razor` は `MyApp.Components.Pages` にあります。どちらのファイルにも `MyApp.Components.Layout` の `@using` はなく、両者をつなぐ `_Imports.razor` もありません。ビルド:

```text
Components\Pages\Home.razor(3,2): warning RZ10012: Found markup element with unexpected name 'NavMenu'. If this is intended to be a component, add a @using directive for its namespace.
```

ランタイムでは、ページは `<navmenu></navmenu>` をリテラル HTML タグとして描画します。

## 4 つの修正方法、優先順位順

この順序で適用してください。あなたのケースを解決した最初のものでやめてください。

### 1. 最も近い `_Imports.razor` に `@using` を追加する

これが標準的な修正で、警告のテキスト自身が指し示すものです。コンポーネントツリーをカバーする `_Imports.razor` に 1 行入れます:

```razor
@* File: Components/_Imports.razor *@
@using MyApp.Components.Layout
@using MyApp.Components.Shared
```

そのフォルダーにまだ `_Imports.razor` が存在しない場合は作成してください。デフォルトの `dotnet new blazor` テンプレートは `Components/_Imports.razor` に共通の using がすでに接続された状態で 1 つ配置します。

これが機能するのは、Razor SDK がプロジェクトのルートから現在のファイルまでの間にあるすべての `_Imports.razor` を、ディレクティブが現在のファイルの先頭に書かれているかのようにコンパイラーに供給するからです。ここに using を追加すると、そのフォルダー以下のすべての `.razor` (レイアウト、ページ、パーシャルを含む) に伝播します。

### 2. 利用する `.razor` ファイルに直接 `@using` を追加する

コンポーネントが 1 つのファイルからのみ参照されていて、名前空間の汚染を抑えたい場合は、using をインラインで宣言します:

```razor
@* File: Components/Pages/Home.razor *@
@using MyApp.Components.Layout

<h1>Home</h1>
<NavMenu />
```

仕組み的には修正 1 と同じで、スコープが狭いだけです。2 つのフォルダーが同じ短い名前のコンポーネントを定義していて、1 つの場所だけで曖昧さを解消したい場合に便利です。

### 3. コンポーネントに `@namespace` を追加する (Razor Class Library のシナリオ)

コンポーネントが RCL にある場合、自動生成される名前空間は `RootNamespace` と RCL のプロジェクトファイルからの相対パスから導出されます。RCL の `RootNamespace` が実際の名前空間と一致しなかったり、ファイルが C# コンパイラーがそのまま受け入れない名前のフォルダー (数字、ハイフン) の下にあったりすると、生成される名前空間は利用側がインポートするものと一致しません。発生源で不一致を修正するために `@namespace` を追加します:

```razor
@* File: src/MyRcl/Components/Button.razor *@
@namespace MyRcl.Components

<button class="my-rcl-button" @onclick="OnClick">@ChildContent</button>

@code {
    [Parameter] public RenderFragment? ChildContent { get; set; }
    [Parameter] public EventCallback OnClick { get; set; }
}
```

これで利用側は `@using MyRcl.Components` と書けばクリーンに紐付けできます。`@namespace` がないと、Razor は RCL のレイアウト次第で `MyRcl.src.MyRcl.Components` や `Some.RootNamespace.src.MyRcl.Components` を生成し、`@using` は静かに型を見つけられません。

フォルダーベースの命名を完全にバイパスするには、RCL の `.csproj` に `RootNamespace` を設定する方法もあります:

```xml
<!-- src/MyRcl/MyRcl.csproj -->
<PropertyGroup>
  <RootNamespace>MyRcl</RootNamespace>
</PropertyGroup>
```

### 4. クリーンビルド後も警告が残る場合は IDE のキャッシュをクリアする

Visual Studio の Razor 言語サービスはタグヘルパーディスクリプターをプロジェクトごとにキャッシュします。プロジェクト参照を追加したり名前空間をリネームしたりした後、`obj/` を新しくしてから `dotnet build` がクリーンに通っても、キャッシュは引き続き RZ10012 を報告することがあります。確実なリセット方法は次のとおりです:

```powershell
# Close Visual Studio first, then from the solution root:
Remove-Item -Recurse -Force .vs, **/bin, **/obj
dotnet build
```

ソリューションを開き直してください。最初の IntelliSense ビルドが修正後の状態でディスクリプターキャッシュを再構築します。JetBrains Rider の場合、相当する操作は **File > Invalidate Caches** です。

## 警告をビルド失敗にする

デフォルトの重大度では、壊れたページを描画するビルドがそのまま出荷されてしまいます。引き上げる方法は 2 つあります:

**ターゲット指定 (推奨):** RZ10012 のみをエラーとして扱います。

```xml
<!-- MyApp.csproj, .NET 11 preview 4 -->
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);RZ10012</WarningsAsErrors>
</PropertyGroup>
```

`$(WarningsAsErrors);` プレフィックスは SDK が既に昇格させたものを保持します。これは新しい .NET SDK が時間とともにこのリストに追加していくため重要です。

**包括的:** すべての警告をエラーとして扱います。全体としてはより健全な規律ですが、SDK が出したあらゆる他の警告を追いかけることを強いられるので、1 つの修正のためにほとんどのチームが望む以上の掃除になります。

```xml
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

いずれにしても、欠落した `@using` は「ボタンが何もしない」というチケットとして QA に漏れるのではなく、ビルドを止めるようになります。

## 間違ってここに辿り着く一般的なバリエーション

**小文字のタグ名。** `<navMenu />` は RZ10012 を出しません。最初の文字が小文字で、Razor はこれを HTML として分類するからです。コンポーネントがリテラルマークアップとして描画され、警告が**出ていない**場合は、名前空間ではなく大文字小文字のバグです。タグを PascalCase にリネームしてください。

**コンポーネントをマスクする `@inherits`。** .NET 7.0.302 以前には既知の問題 ([dotnet/razor#8800](https://github.com/dotnet/razor/issues/8800)) があり、コンポーネントに `@inherits MyBase` を追加するとコンパイラーがコンポーネント性を失い、使われている場所すべてで RZ10012 を出していました。.NET 8 で修正されています。まだ .NET 7 でアップグレードできない場合は、ディレクティブではなく `@code { protected partial class ... }` で継承して回避してください。

**サードパーティのコンポーネントライブラリが未登録。** MudBlazor、Radzen、Telerik、Syncfusion を使う場合、ライブラリは `_Imports.razor` のスニペットを提供し、それを自分のファイルに貼り付ける必要があります。それを忘れると、すべての `<MudButton />` が RZ10012 で光ります。ベンダーの「getting started」ページに正確な一覧があります (MudBlazor は `@using MudBlazor`、Radzen は `@using Radzen` と `@using Radzen.Blazor` など)。

**型パラメーター付きの generic コンポーネント。** `<MyList T="string" />` も、`MyList<T>` がスコープにないと警告を出します。`T="..."` 属性は名前空間をインポートしません。`@using` のルールが同じように適用されます。

**VS 17.4.x のエディター誤検知。** [dotnet/razor#8146](https://github.com/dotnet/razor/issues/8146) は VS 2022 の初期リリースにおける一連の誤検知を追跡しています。ビルドはクリーンなのに IDE のみ RZ10012 を表示する場合は、VS を 17.6 以降に更新し、修正 4 と同じく `.vs/` をクリアしてください。

**別のフレームワークをターゲットにする参照プロジェクトのコンポーネント。** `net6.0` をターゲットにする Razor Class Library を `net11.0` のアプリが使うとき、RCL に `<UseRazorSourceGenerator>true</UseRazorSourceGenerator>` がない、または SDK の参照が古いと、コンポーネントが公開されないことがあります。RCL の `<PackageReference>` を `Microsoft.AspNetCore.App` 11 に更新して再ビルドしてください。

## 30 秒のチェックリスト

RZ10012 が CI で発生し、急いで飛行機に乗る必要があるとき、このリストを上から順番に進めてください:

1. タグは PascalCase ですか? 小文字ならリネーム。
2. コンポーネントは**このプロジェクト**にありますか? Yes なら、最も近い `_Imports.razor` でその名前空間を `@using`。
3. コンポーネントは RCL にありますか? RCL に `@namespace` がインポートと一致して付いているか、利用側が RCL のパッケージまたはプロジェクトを参照しているか確認。
4. サードパーティ製? ベンダーのスニペットを `_Imports.razor` に貼り付け。
5. クリーンビルド後も警告が出ますか? `.vs/`、`bin/`、`obj/` を削除して再ビルド。
6. CI を失敗させたいですか? `<WarningsAsErrors>` に `RZ10012` を追加。

90% のケースはステップ 2 かステップ 4 です。残りは名前空間の配管工事です。

## 関連

- [Fix: The type or namespace name could not be found after a project reference](/ja/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) は同じ名前空間解決失敗ファミリーの C# 側をカバーします。
- [サーバーと Blazor WebAssembly でバリデーションロジックを共有する方法](/ja/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) は RZ10012 が最も発生しやすい複数プロジェクト構成を解説します。
- [.NET 11 で Tailwind CSS を Blazor WebAssembly と組み合わせて使う方法](/ja/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) は比較できるクリーンな Blazor プロジェクト構成を示します。
- [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は、RZ10012 で防げたはずの「タグが生の HTML として描画される」バグを捕まえるためのランタイム側の対応策です。

## ソース

- [dotnet/aspnetcore#45427: Referenced Razor Class Library component reporting error RZ10012](https://github.com/dotnet/aspnetcore/issues/45427)
- [dotnet/razor#8800: `@inherits` breaks component recognition](https://github.com/dotnet/razor/issues/8800)
- [dotnet/razor#8146: Unusable Blazor analyzers blinking invalid RZ10012 warnings in VS 17.4.x](https://github.com/dotnet/razor/issues/8146)
- [Microsoft Learn: ASP.NET Core Blazor namespaces](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/?view=aspnetcore-9.0#namespaces)
- [Jonathan Crozier: Treat Blazor component warnings as errors](https://jonathancrozier.com/blog/treat-blazor-component-warnings-as-errors-found-markup-element-with-unexpected-name)

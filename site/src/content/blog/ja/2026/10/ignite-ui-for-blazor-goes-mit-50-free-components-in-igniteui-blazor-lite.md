---
title: "Ignite UI for Blazor が MIT ライセンスに: IgniteUI.Blazor.Lite 1.0.0 で 50 以上のコンポーネントが無料に"
description: "Infragistics は 50 以上の Ignite UI for Blazor コントロールを MIT ライセンスでオープンソース化し、net8.0、net9.0、net10.0 向けの IgniteUI.Blazor.Lite と IgniteUI.Blazor.GridLite 1.0.0 として公開しました。何が無料なのか、どのように組み込むのか、注意点をまとめます。"
pubDate: 2026-10-28
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet"
  - "nuget"
lang: "ja"
translationOf: "2026/10/ignite-ui-for-blazor-goes-mit-50-free-components-in-igniteui-blazor-lite"
translatedBy: "claude"
translationDate: 2026-10-28
---

2026年10月27日、ASP.NET チームは Infragistics が Blazor のコントリビューターになったことを[発表しました](https://devblogs.microsoft.com/dotnet/blazor-welcomes-infragistics/)。多くの開発者にとって注目すべき点はライセンスです。50 以上の Ignite UI for Blazor コントロールが MIT ライセンスとなり、商用利用も無料で、ソースは [GitHub](https://github.com/IgniteUI/igniteui-blazor) で公開されています。これは試用版ではありません。商用スイートの恒久的なサブセットです。

## 実際に無料なのは何か

パッケージは 2 つで、どちらも NuGet 上で 1.0.0 であり、`net8.0`、`net9.0`、`net10.0` を対象としています。

- `IgniteUI.Blazor.Lite`: 入力、ナビゲーション、レイアウトのコントロール。Combo、Date Picker、Date Range Picker、Tree、Stepper、Tile Manager、Splitter、Dialog、Tabs、Calendar、Mask Input、Slider、Rating、Chat (プレビュー) のほか、約 40 種類が含まれます。
- `IgniteUI.Blazor.GridLite`: 列フィルターとカスタムセルテンプレートに対応した軽量データグリッド。

完全版の Grid、Tree Grid、Pivot Grid、Hierarchical Grid、Dock Manager は、これまでどおり `IgniteUI.Blazor` パッケージで商用扱いです。グループ化、編集、Excel エクスポートが必要な場合、Grid Lite はそのためのグリッドではありません。

## Blazor Web App への組み込み

```bash
dotnet add package IgniteUI.Blazor.Lite --version 1.0.0
```

`Program.cs` でサービスを登録し、`_Imports.razor` で名前空間をインポートします。

```csharp
builder.Services.AddIgniteUIBlazor();
```

```razor
@using IgniteUI.Blazor.Controls
```

次に、`Components/App.razor` (スタンドアロンの WebAssembly では `wwwroot/index.html`) にテーマを追加します。

```html
<link href="_content/IgniteUI.Blazor/themes/light/bootstrap.css" rel="stylesheet" />
```

パスに注意してください。`_content/IgniteUI.Blazor.Lite/` ではなく `_content/IgniteUI.Blazor/` です。1.0.0 パッケージを確認したところ、静的 Web アセットの `BasePath` が `_content/IgniteUI.Blazor` に設定されており、Lite パッケージと商用パッケージは同じアセット URL を共有しています。"それらしい" パスを推測すると、スタイルが適用されないコンポーネントと、ネットワークタブの 404 に遭遇します。テーマは `bootstrap`、`fluent`、`indigo`、`material` が用意されており、それぞれに `light` と `dark` があります。

`<script>` タグは不要です。JavaScript イニシャライザーが Blazor の起動時に Web コンポーネントを読み込みます。

## 実データをバインドする Combo

`IgbCombo` は `TValue` と `TItem` に対するジェネリックで、`SingleSelect` を指定した場合でも `Value` は常に `TValue[]` です。初めて使うときに引っかかりやすい点です。

```razor
@rendermode InteractiveServer

<IgbCombo TItem="City" TValue="int"
          Data="cities"
          ValueKey="Id"
          DisplayKey="Name"
          Label="Destination"
          SingleSelect="true"
          @bind-Value="selected" />

<p>Selected id: @(selected.FirstOrDefault())</p>

@code {
    record City(int Id, string Name);

    City[] cities = [new(1, "Bucharest"), new(2, "Cluj"), new(3, "Iasi")];
    int[] selected = [];
}
```

`@rendermode` の行は重要です。これらのコンポーネントは JavaScript 相互運用の上に構築されているため、`InteractiveServer`、`InteractiveWebAssembly`、`InteractiveAuto` のいずれかが必要です。静的 SSR はサポートされておらず、レンダーモードのないページでは動作しないマークアップが出力されるだけです。

## .NET 11 に入る部分

Infragistics のエンジニアは、.NET 11 向けにマージされた 2 つの Blazor アナライザーも提供しました ([dotnet/aspnetcore#67176](https://github.com/dotnet/aspnetcore/pull/67176) と [#67383](https://github.com/dotnet/aspnetcore/pull/67383))。1 つ目は、`ComponentBase` がすでに行っているため冗長になった `StateHasChanged()` の呼び出し (たとえば `OnInitializedAsync` の最初の `await` の直前の呼び出し) を検出し、それらを削除するコード修正も提供します。2 つ目は、クラスが `AuthenticationStateChanged` を購読せずに `GetAuthenticationStateAsync()` を呼び出している場合に警告します。これは、キャッシュされた古いユーザー情報が残る原因になります。

コーディングエージェント向けに、[dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-blazor/skills/use-igniteui-blazor) には `use-igniteui-blazor` スキルもあります。また、スキャフォルダーは [dotnet/Scaffolding#3823](https://github.com/dotnet/Scaffolding/pull/3823) でまだレビュー中です。

席ごとのライセンス費用を理由にコンポーネントベンダーを避けてきたチームにとって、Blazor チームのトリミングとアクセシビリティの基準を満たす MIT ライセンスの無料の Combo、Date Range Picker、Tree は、今週中に試してみる価値があります。

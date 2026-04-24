---
title: ".NET MAUI 11 Maps に pin clustering が着陸"
description: ".NET MAUI 11 Preview 3 は Android と iOS の Map コントロールにビルトイン pin clustering を追加し、ClusteringIdentifier グループと ClusterClicked イベントを備えます。"
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "maps"
  - "mobile"
lang: "ja"
translationOf: "2026/04/dotnet-maui-11-map-pin-clustering"
translatedBy: "claude"
translationDate: 2026-04-24
---

.NET MAUI の `Map` に数百個の pin を落としたことがあるなら、ズームレベル 6 で何が起こるか知っているはずです: 誰もタップできない重なり合ったマーカーの塊です。コミュニティプラグインのエコシステムは何年もこの隙間を埋めてきましたが、clustering のためだけにサードパーティの maps ライブラリを出荷するのは常に重く感じられました。[.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/pin-clustering-in-dotnet-maui-maps/) は `Microsoft.Maui.Controls.Maps` に焼き込まれた first-party の clustering 実装でそれを修正します。

## 有効化

Clustering は `Map` コントロール上の単一のブール値を通じて opt-in です。`IsClusteringEnabled` を切り替えると、既存の `Pins` コレクションがズームアウトに応じて自動的に cluster マーカーにグループ化されます:

```xml
<maps:Map x:Name="StoresMap"
          IsClusteringEnabled="True"
          MapType="Street" />
```

Android では、裏の実装はカメラ変更のたびに cluster バケットを再計算するカスタムグリッドベースのアルゴリズムを使います。iOS と Mac Catalyst ではネイティブ MapKit の `MKClusterAnnotation` に引き渡すので、clustering の挙動はユーザーが Apple Maps や Find My ですでに見ているものと一致します。Windows はまだサポートされていませんが、それは `Map` コントロール全般のプラットフォームマトリックスと合致しています。

## ClusteringIdentifier で pin タイプを分離

実際のアプリはすべての pin を同じバケットに入れたいことは滅多にありません。配送アプリは倉庫を受け渡し地点と別にクラスタリングする必要があり、旅行アプリはホテルとレストランが重なっていても別々に残したいはずです。`Pin` の `ClusteringIdentifier` プロパティがどの pin を一緒にクラスタリングするかを制御します: identifier を共有する pin は 1 つのバケットを得て、異なる identifier の pin は独立したバケットを形成します。

```csharp
foreach (var store in cafes)
{
    StoresMap.Pins.Add(new Pin
    {
        Label = store.Name,
        Location = new Location(store.Lat, store.Lng),
        ClusteringIdentifier = "cafe"
    });
}

foreach (var charger in chargingStations)
{
    StoresMap.Pins.Add(new Pin
    {
        Label = charger.Name,
        Location = new Location(charger.Lat, charger.Lng),
        ClusteringIdentifier = "charger"
    });
}
```

これが揃うと、密集した都市ビューは、無関係な pin を単一のカウントに折りたたむ代わりに、同じ場所に 2 つの cluster マーカーをレンダリングします。

## Cluster タップへの反応

デフォルトのタップ挙動は cluster にズームインすることで、通常はそれが望みです。近くの結果のシートを表示したり詳細データをロードしたりといったもっとリッチなものが必要なら、`ClusterClicked` を購読します。イベント引数は完全な pin リスト、cluster の地理的中心、デフォルトのズームを抑制する `Handled` フラグを提供します:

```csharp
StoresMap.ClusterClicked += async (sender, e) =>
{
    var names = string.Join(", ", e.Pins.Select(p => p.Label));
    await Shell.Current.DisplayAlert(
        $"{e.Pins.Count} places nearby",
        names,
        "OK");

    e.Handled = true;
};
```

`e.Handled = true` を設定することで、カメラをそこに保ち、代わりにカスタム UI を提示できます。

## なぜこれが待っていたアップグレードか

Preview 3 以前、実用的な選択肢は `CameraChanged` の上に手で clustering アルゴリズムを書くか、`Map` コントロールを MPowerKit.GoogleMaps のようなプラットフォーム固有ラッパーに置き換えるかでした。どちらにも欠点がありました: 前者は MapKit 自身の座標スナッピングと戦い、後者は `Microsoft.Maui.Controls.Maps` を完全にバイパスしました。`IsClusteringEnabled`、`ClusteringIdentifier`、`ClusterClicked` を箱の中に持つことで、既存のバインディングとデータテンプレートを維持し、1 つのプロパティを追加して出荷できます。

この機能は .NET 11 のより広い [Maps Control Improvements epic](https://github.com/dotnet/maui/issues/33787) の一部なので、年内遅くの GA までにスタイリングとインタラクション周りのさらなる磨きを期待してください。今のところ、[.NET 11 Preview 3 SDK](https://dotnet.microsoft.com/download/dotnet/11.0) をインストールし、MAUI ワークロードを更新して、プラットフォームに山積みの処理を任せてください。

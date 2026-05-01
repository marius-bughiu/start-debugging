---
title: "UWP - Xamarin Forms の MasterDetail メニューで Acrylic Brush を使う"
description: "Xamarin Forms の MasterDetail メニューに、サードパーティライブラリなしのプラットフォーム固有 native renderer を使って UWP の Acrylic Brush を適用します。"
pubDate: 2018-01-16
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2018/01/using-acrylic-brush-xamarin-forms-masterdetail"
translatedBy: "claude"
translationDate: 2026-05-01
---
さて、Xamarin Forms アプリで UWP もターゲットにしている方で、新しい Acrylic Brush を使ってアプリを引き立たせたい人向けの内容です。前置きはここまで。

![UWP 上の Gazeta Acrylic メニュー](https://image.ibb.co/fTPyrm/gazeta_acrylic.gif)

サードパーティのライブラリ／パッケージは使わず、プラットフォーム固有プロジェクトで作業します。UWP プロジェクト内の **MainPage.xaml.cs** を開いてください。最初にすべきことは、MasterDetail の Master ページへの参照を取得することです。私のケースでは MasterDetail = MainPage なので、話は単純です。

```cs
var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
```

次に、Master ページの native renderer を取得する必要があります。これによって Background brush を変更できるようになります。

```cs
var renderer = Platform.GetRenderer(masterPage) as PageRenderer;
```

ブラシを作成し、renderer に割り当てます。これにより XAML 上で ContentPage に設定した BackgroundColor は上書きされますが、それで問題ありません。Android と iOS は引き続き XAML で定義した値を使い、UWP では新しい AcrylicBrush を使うことになります。

```cs
var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.TintOpacity = 0.8;

renderer.Background = acrylicBrush;
```

TintColor と FallbackColor は XAML で設定したカラーに合わせ、不透明度は 80% にしました。希望する効果になるまでこれらの値を調整してみてください。各プロパティの役割は次のとおりです。

> -   **TintColor**: 色 / ティントを重ねるレイヤー。RGB の色と alpha チャンネルの不透明度の両方を指定することを検討してください。
> -   **TintOpacity**: ティントレイヤーの不透明度。出発点として 80% を推奨しますが、色によっては別の透明度のほうが良く見えることがあります。
> -   **BackgroundSource**: background acrylic にするか in-app acrylic にするかを指定するフラグ。
> -   **FallbackColor**: バッテリー残量低下モードで acrylic を置き換える単色。background acrylic では、アプリがアクティブなデスクトップウィンドウにないとき、または phone や Xbox で動作しているときにも fallback color が acrylic を置き換えます。

Acrylic マテリアルの仕組みについては [こちら](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic) をご覧ください。万一うまくいかない場合のために、MainPage 全体を載せておきます。

```cs
public sealed partial class MainPage
{
    public MainPage()
    {
        this.InitializeComponent();
        var app = new GazetaSporturilor.App();
        LoadApplication(app);

        var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
        var renderer = Platform.GetRenderer(masterPage) as PageRenderer;

        var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
        acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
        acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.TintOpacity = 0.8;

        renderer.Background = acrylicBrush;
    }
}
```

---
title: "Xamarin Forms - OnPlatform を使う"
description: "Xamarin Forms で OnPlatform を使い、XAML と C# の両方でプラットフォーム固有のプロパティ値を設定する方法を学びます。"
pubDate: 2019-07-27
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2019/07/xamarin-forms-using-onplatform"
translatedBy: "claude"
translationDate: 2026-05-01
---
Xamarin Forms アプリケーションの開発では、特定のプロパティに対して OS ごとに異なる値を設定したい場面によく出会います。

OnPlatform はまさにそれを実現でき、C# コードからも XAML からも利用できます。いくつか例を見ていきましょう。本記事では新規の master-detail プロジェクトを使います。

## XAML で OnPlatform を使う

About ページに Learn More ボタンがあります。その色を、Android では緑、iOS ではオレンジ、UWP では紫といった具合に、プラットフォーム依存にしてみましょう。

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
    BackgroundColor="{OnPlatform Android=Green, iOS=Orange, UWP=Purple}"
    Command="{Binding OpenWebCommand}"
    TextColor="White" />
```

結果を見てみましょう。

![](/wp-content/uploads/2019/07/xamarin-forms-on-platform.png)

あるいは、より複雑なデータ型を扱うときに便利な、次の構文も使えます。

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
        Command="{Binding OpenWebCommand}"
        TextColor="White">
    <Button.BackgroundColor>
        <OnPlatform x:TypeArguments="Color">
            <On Platform="Android" Value="Green"/>
            <On Platform="iOS" Value="Orange"/>
            <On Platform="UWP" Value="Purple"/>
        </OnPlatform>
    </Button.BackgroundColor>
</Button>
```

## C# で OnPlatform を使う (非推奨)

要件は上と同じですが、今回は XAML ではなく C# で書きます。まずボタンに x:Name="LearnMoreButton" を付け、コードビハインドで次のように書きます。

```cs
Device.OnPlatform(
    Android: () => this.LearnMoreButton.BackgroundColor = Color.Green, 
    iOS: () => this.LearnMoreButton.BackgroundColor = Color.Orange, 
    WinPhone: () => this.LearnMoreButton.BackgroundColor = Color.Purple,
    Default: () => this.LearnMoreButton.BackgroundColor = Color.Black);
```

結果は先ほどと同じです。WinPhone は UWP にマップされ、その他のプラットフォーム向けに既定値も指定できます。このメソッドは XF 2.3.4 で非推奨になっており、代わりに Device.RuntimePlatform を使った switch case を自前で書くことが推奨されます。

## 代わりに Device.RuntimePlatform を使う

上記コードは次のように書き換えられます。

```cs
switch (Device.RuntimePlatform)
{
    case Device.Android:
        LearnMoreButtonSwitch.BackgroundColor = Color.Green;
        break;
    case Device.iOS:
        LearnMoreButtonSwitch.BackgroundColor = Color.Orange;
        break;
    case Device.UWP:
        LearnMoreButtonSwitch.BackgroundColor = Color.Purple;
        break;
     default:
         LearnMoreButtonSwitch.BackgroundColor = Color.Black;
         break;
}
```

現在サポートされているプラットフォーム値は: iOS、Android、UWP、macOS、GTK、Tizen、WPF です。

サンプルプロジェクトのソースコードはもともと GitHub にありましたが、リポジトリは現在公開されていません。

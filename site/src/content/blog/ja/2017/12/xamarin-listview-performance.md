---
title: "Xamarin の ListView パフォーマンスと Syncfusion SfListView への置き換え"
description: "キャッシング戦略、テンプレート最適化、Syncfusion SfListView を使って、Xamarin Forms の ListView スクロールパフォーマンスを改善します。"
pubDate: 2017-12-16
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2017/12/xamarin-listview-performance"
translatedBy: "claude"
translationDate: 2026-05-01
---
Xamarin はアップデートのたびに機能を追加し、Xamarin Forms のパフォーマンスを向上させていますが、クロスプラットフォームのユーザーコントロールに関しては必ずしも十分ではありません。私の場合、複数のソースからニュース記事を集め、こんな ListView で表示する RSS リーダーアプリがあります。

見た目は気に入っているのですが、大きな問題が 1 つあります -- パフォーマンスです。ハイエンド端末でもスクロールがもたつき、ロー端末では読み込まれる画像のせいで OutOfMemory exceptions が頻発します。改善が必要でした。本記事では最初の問題、スクロールパフォーマンスのみを扱います。OutOfMemory exceptions についてはまた別の機会に。

### Item template

パフォーマンスのトラブルシューティングで最初に確認すべきは ListView の ItemTemplate です。このレベルでの最適化は、ListView 全体のパフォーマンスに大きく影響します。次の点を確認してください。

-   XAML 要素の数を減らす。レンダリングする要素は少ないほど良い
-   ネストにも同じことが言えます。要素のネストを避け、深い階層を作らないこと。レンダリングに時間がかかりすぎます
-   ItemSource は IEnumerable ではなく IList になっていることを確認する。IEnumerable はランダムアクセスをサポートしません
-   BindingContext によって layout を変更しないでください。代わりに DataTemplateSelector を使います

これらの変更だけで、スクロールがいくらか改善されるはずです。次は caching 戦略です。

### Caching 戦略

既定では、Xamarin は Android と iOS で RetainElement caching 戦略を使うため、リストの各アイテムごとに ItemTemplate のインスタンスが 1 つずつ作成されます。ListView の caching strategy を RecycleElement に変更し、毎回新しい要素を作るのではなく、画面外に出たコンテナーを再利用するようにしてください。これにより、初期化コストが削減され、パフォーマンスが向上します。

```xml
<ListView CachingStrategy="RecycleElement">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
              ...
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

万一 DataTemplateSelector を使っている場合は、RecycleElementAndDataTemplate caching 戦略を使ってください。caching 戦略の詳細は、ListView パフォーマンスに関する [Xamarin のドキュメント](https://learn.microsoft.com/en-us/xamarin/xamarin-forms/user-interface/listview/performance) を確認してください。

### Syncfusion ListView

ここまで来てもパフォーマンスの問題が解決しない場合は、別の選択肢を検討する時期です。私の場合は Syncfusion SfListView を試しました。Syncfusion はコントロールスイートで知られており、Xamarin コントロールも Visual Studio Community とほぼ同じ条件で無料提供しています。まず Syncfusion のサイトから [無料の community ライセンスを取得](https://www.syncfusion.com/products/communitylicense) してください。

次に SfListView パッケージをプロジェクトに追加します。Syncfusion のパッケージは独自の NuGet リポジトリで提供されています。アクセスするには、それを NuGet sources に追加する必要があります。詳しい手順は [こちら](https://help.syncfusion.com/xamarin/listview/getting-started) にあります。設定が終わったら、NuGet で SfListView を検索すれば目的のパッケージが見つかります。コア / クロスプラットフォームプロジェクトおよび各プラットフォームプロジェクトすべてにパッケージをインストールしてください。プロジェクトの target に応じて適切な DLL が自動で選ばれます。

すべてのインストールが終わったので、標準の ListView を置き換える時間です。page/view に次の名前空間を追加します。

```xml
xmlns:sflv="clr-namespace:Syncfusion.ListView.XForms;assembly=Syncfusion.SfListView.XForms"
```

そして ListView タグを sflv:ListView に、ListView.ItemTemplate を sflv:SfListView.ItemTemplate に置き換え、階層から ViewCell を取り除きます -- 不要です。さらに、CachingStrategy プロパティを使っていた場合はそれも取り除いてください -- SfListView は既定で要素を再利用します。最終的にはこんな形になるはずです。

```xml
<sflv:SfListView>
    <sflv:SfListView.ItemTemplate>
        <DataTemplate>
           ...
        </DataTemplate>
    </sflv:SfListView.ItemTemplate>
</sflv:SfListView>
```

以上です。質問があれば下のコメント欄で教えてください。ListView のパフォーマンスを改善する他のヒントがあれば、ぜひ共有してください。

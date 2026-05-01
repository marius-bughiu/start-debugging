---
title: "Xamarin Forms 3 で CSS を始める"
description: "Xamarin Forms 3 で Cascading StyleSheets (CSS) を使う方法を、インラインの CDATA スタイルと埋め込み CSS ファイルの両方の例を交えて解説します。"
pubDate: 2018-04-18
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2018/04/getting-started-with-css-in-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
今回の Xamarin Forms の新バージョンには新機能がいくつかあり、その 1 つが Cascading StyleSheets (CSS) です。そう、XAML 内の CSS です。どれほど便利でどこまで広く使われるかはまだ分かりません -- 不足している機能もそれなりにあります -- が、Web 開発から移ってきたい人にとっては歓迎される追加機能になりそうです。

早速本題ですが、CSS をアプリケーションに追加する方法は 2 つあります。

-   1 つ目は、要素のリソース内に直接スタイルを置き、CDATA タグで包む方法
-   もう 1 つは、プロジェクトに embedded resource として実際の .css ファイルを追加する方法

CSS を含めたら、XAML 要素に **StyleClass** か、その短縮形である **class** プロパティを指定して使います。

例として、master detail テンプレートを使った新しい Xamarin Forms プロジェクトに変更を加えます。File > New project から作成し、Xamarin Forms 3 にアップグレードしてください。

まずは CDATA の方法です。リストの要素をオレンジ色にしたいとします。ItemsPage を開き、XAML 内の `<ContentPage.ToolbarItems>` タグの上に次を追加します。

```xml
<ContentPage.Resources>
    <StyleSheet>
        <![CDATA[

            .my-list-item {
                padding: 20;
                background-color: orange;
                color: white;
            }

        ]]>
    </StyleSheet>
</ContentPage.Resources>
```

次にこの新しい .my-list-item クラスを使います。ListView の ItemTemplate を見つけ、その中の StackLayout に注目してください -- それが対象です。padding を取り除き、私たちのクラスを次のように適用します。

```xml
<StackLayout Padding="10" class="my-list-item">
```

これで完了です。

では 2 つ目のアプローチ、embedded CSS ファイルを使う方法を見てみましょう。まずアプリ内に Styles という新しいフォルダーを作成し、その中に about.css というファイルを作ります (この部分では About ページをスタイルします)。ファイルを作成したら、必ず右クリック > Properties で **Build action** を **Embedded resource** に設定してください。そうしないと動作しません。

次にビュー -- AboutPage.xaml -- で、<ContentPage.BindingContext> 要素のすぐ上に次を追加します。これでページから CSS ファイルを参照できます。パスが "/" で始まることは、ルートから始まることを意味します。先頭のスラッシュを省略すれば相対パスも指定できます。

```xml
<ContentPage.Resources>
   <StyleSheet Source="/Styles/about.css" />
</ContentPage.Resources>
```

CSS の方は、アプリのタイトルと learn more ボタンに少し変更を加えてみます。

```css
.app-name {
    font-size: 48;
    color: orange;
}

.learn-more {
    border-color: orange;
    border-width: 1;
}
```

注意: font-size や border-width は単純な (double) 値です。"px" は指定しないでください。動作せずエラーになります。値は DIP (device independent pixels) として解釈されているのでしょう。同じことが thickness、margin、padding などのプロパティにも当てはまります。

すべてが綺麗に見えますが、いくつかの制約があることを覚えておいてください。

-   このバージョンではすべてのセレクターがサポートされているわけではありません。\[attribute\] セレクター、@media、@supports、そして : や :: のセレクターはまだ動きません。また、私の試した範囲では、.class1.class2 のように複数クラスで要素を絞り込むこともできません。
-   すべてのプロパティがサポートされているわけではなく、さらに重要なのは、サポートされているプロパティすべてがすべての要素で動くわけではないことです。例えば text-align は Entry、EntryCell、Label、SearchBar でのみサポートされており、Button のテキストを左寄せにはできません。あるいは border-width は buttons でしか機能しません。
-   継承はサポートされていません

サポート / 非サポートの完全な一覧は [GitHub 上のこの機能の pull request](https://github.com/xamarin/Xamarin.Forms/pull/1207) を確認してください。万一うまくいかない場合に備えて: オリジナルのサンプルリポジトリは現在 GitHub では公開されていませんが、上のスニペットだけで十分始められるはずです。

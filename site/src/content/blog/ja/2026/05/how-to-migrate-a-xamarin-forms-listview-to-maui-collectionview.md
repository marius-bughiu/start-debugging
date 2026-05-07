---
title: "高パフォーマンスな Xamarin.Forms ListView を MAUI CollectionView へ移行する"
description: "ListView からすでにパフォーマンスを絞り出していたアプリ向けの、Xamarin.Forms 5.0 ListView から .NET MAUI 11 CollectionView へのステップバイステップな移行ガイド。セルのリサイクル、仮想化、グルーピング、プルツーリフレッシュ、コンテキストアクション、選択、ItemsLayout、EmptyView、そして実アプリで踏みがちな落とし穴を扱います。"
pubDate: 2026-05-07
updatedDate: 2026-05-07
template: migration
tags:
  - "maui"
  - "xamarin"
  - "xamarin-forms"
  - "collectionview"
  - "listview"
  - "migration"
  - "dotnet"
lang: "ja"
translationOf: "2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview"
translatedBy: "claude"
translationDate: 2026-05-07
---

短く言うと、`ListView` を `CollectionView` に置き換え、プルツーリフレッシュが必要なら `RefreshView` でラップし、`ContextActions` を `SwipeView` に差し替え、MAUI ではセルリサイクル付き仮想化が唯一のモードなので `HasUnevenRows`、`RowHeight`、`CachingStrategy` を捨て、選択は `ItemTapped` / `ItemSelected` から `SelectionMode` と `SelectionChangedCommand` に書き直します。古い `ListView` が `CachingStrategy="RecycleElement"`、`HasUnevenRows="True"`、`DataTemplateSelector` でチューニングされていたなら、移行は概ね機械的です。.NET MAUI 11.0 GA で `net11.0-android35.0`、`net11.0-ios18.0`、`net11.0-maccatalyst18.0` 上でテスト済みです。リストが 5 から 10 個あるアプリで集中的に 1 から 3 日の作業を見込んでください。`TableView` 風のグルーピングやカスタムの `ViewCell` レンダラーに大きく依存しているならもう少しかかります。

Xamarin.Forms は [2024 年 5 月 1 日](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)にサポートが終了し、MAUI 11 GA は 2025 年 11 月にリリースされ、Android のジャンク対策として CollectionView の修正の第 3 世代が含まれています。`RecycleElementAndDataTemplate` のような `ListView` の癖に合わせてアプリのパフォーマンスを手作業でチューニングしていたために移行を見送ってきたのなら、今こそアップグレードの価値があります。MAUI 11 の CollectionView は、`ItemSizingStrategy.MeasureAllItems` を切れば、ようやく Android 上で旧 Xamarin.Forms の `ListView` に匹敵するか、それを上回るようになりました。本稿はその層に向けたガイドです。

## なぜ今移行するのか

- Xamarin.Forms はサポート対象外です。CVE パッチも、Android 15 / iOS 18 向けの修正もありません。アプリストアはターゲット SDK の引き上げを今後も強制しますが、Xamarin.Forms ではそれに追随できません。
- CollectionView は MAUI においてプラットフォームネイティブの仮想化コレクション (Android では `RecyclerView`、iOS では `UICollectionView`) を使う唯一のコレクションコントロールです。`ListView` は後方互換性のために MAUI に存在しますが、[内部では CollectionView に委譲する薄いラッパー](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview)であり、レガシーなレンダラーではなくレガシーな API 形状だけを引き継いでいます。
- `ItemsLayout` を使えば、サブクラス化やリピーターのハックなしに、線形レイアウトとグリッドレイアウトを切り替えられます。同じコントロールが、かつて `ListView` と `FlowListView` の組み合わせで必要だったものをカバーします。
- `EmptyView` は本物のテンプレート化されたプロパティであり、兄弟ラベルを手作業で `IsVisible` トグルする必要はありません。

## 何が壊れるのか

| 領域 | Xamarin.Forms ListView | MAUI CollectionView | 重大度 |
| ---- | ---------------------- | ------------------- | -------- |
| キャッシング戦略 | `CachingStrategy="RetainElement"` または `RecycleElement` | 常にリサイクルされる。プロパティは存在しない。 | 中 |
| 行の高さ | `HasUnevenRows`、`RowHeight` | `ItemSizingStrategy="MeasureAllItems"` または `MeasureFirstItem` | 中 |
| プルツーリフレッシュ | `ListView` 上の `IsPullToRefreshEnabled`、`RefreshCommand` | `RefreshView` でラップ | 高 |
| セルの型 | `ViewCell`、`TextCell`、`ImageCell` | 任意のレイアウトをルートにできる素の `DataTemplate` | 高 |
| タップ処理 | `ItemTapped`、`ItemSelected` | `SelectionMode`、`SelectionChanged`、`SelectionChangedCommand` | 高 |
| スワイプアクション | `ContextActions` | `SwipeView` | 高 |
| セパレーター | `SeparatorVisibility`、`SeparatorColor` | なし。テンプレートに `BoxView` を追加する。 | 低 |
| ヘッダー / フッター | `Header`、`Footer` (オブジェクトまたはテンプレート) | 名前は同じだが、テンプレート / ビューとしてのみ | 低 |
| グルーピング | `IsGroupingEnabled`、`GroupHeaderTemplate` | `IsGrouped`、`GroupHeaderTemplate`、`GroupFooterTemplate` | 中 |
| スクロール | `ScrollTo(item, ScrollToPosition)` | `ScrollTo(item, position, animate)` | 低 |
| 空状態 | 兄弟ラベルを手作業で | `EmptyView`、`EmptyViewTemplate` | 低 |

痛い変更はプルツーリフレッシュと選択の 2 つです。それ以外はそのままのリネームか削除です。

## 事前チェックリスト

1. .NET 11 SDK がインストール済みであること (`dotnet --version` が `11.0.x` を返す)。MAUI 11 には .NET 11 SDK が必要です。それより古い SDK にはワークロードマニフェストがありません。
2. MAUI ワークロードがインストール済みであること: `dotnet workload install maui`。古いインストールの上にアップグレードした場合は、まず `dotnet workload repair` を実行してください。
3. Android SDK 35、iOS 18、Mac Catalyst 18 のプラットフォームが利用可能であること。Visual Studio 2022 17.13、または .NET MAUI 拡張機能 1.6 以上の Visual Studio Code が必要です。
4. 捨ててよい `git` ブランチ。MAUI のビルドが実機で緑色になるまでは、`main` 上で Xamarin.Forms プロジェクトをコンパイルできる状態に保ってください。
5. プロジェクト内のすべての `ListView` インスタンスのリスト。機能領域ごとにグループ化し、機能を 1 つずつ移行します。リリースサイクルが月次なら機能フラグの背後に隠してリリースしてください。
6. プロジェクトに対して [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) を一度実行し、`csproj`、名前空間、`MauiProgram` の変更を処理します。Upgrade Assistant は `ListView` の XAML までは書き換えてくれません。本稿の残りの部分が扱うのはまさにそこです。

## 移行手順

### 1. `ListView` を `CollectionView` に置き換える

最もシンプルなケースは、カスタムの `DataTemplate` を持つフラットなリストです。

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ListView ItemsSource="{Binding Articles}"
          CachingStrategy="RecycleElementAndDataTemplate"
          HasUnevenRows="True"
          SeparatorVisibility="None"
          ItemTapped="OnArticleTapped">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
                <Grid Padding="12" RowDefinitions="Auto,Auto">
                    <Label Text="{Binding Title}" FontAttributes="Bold" />
                    <Label Grid.Row="1" Text="{Binding Excerpt}" />
                </Grid>
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding Articles}"
                SelectionMode="Single"
                SelectionChangedCommand="{Binding OpenArticleCommand}"
                SelectionChangedCommandParameter="{Binding Source={RelativeSource Self}, Path=SelectedItem}">
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <Grid Padding="12" RowDefinitions="Auto,Auto">
                <Label Text="{Binding Title}" FontAttributes="Bold" />
                <Label Grid.Row="1" Text="{Binding Excerpt}" />
            </Grid>
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

変わった点は次のとおりです。

- `ViewCell` はなくなりました。テンプレートのルートはレイアウト (`Grid`、`VerticalStackLayout` など) を直接置きます。
- `CachingStrategy` はなくなりました。リサイクルは常に有効です。古い `RecycleElementAndDataTemplate` が最も近い相当品で、現在はそれが唯一のモードです。
- `HasUnevenRows="True"` はなくなりました。CollectionView はデフォルトですべてのセルを測定します。行がすべて同じサイズなら、`ItemSizingStrategy="MeasureFirstItem"` を設定すると Android のスクロール性能が体感できるレベルで向上します。
- `SeparatorVisibility="None"` が新しいデフォルトです。実際にセパレーターが欲しい場合はテンプレート内に `BoxView HeightRequest="1"` を追加します。
- テンプレート上の `x:DataType` はコンパイル済みバインディングを有効にします。常に設定してください。Android ではリフレクションバインディングを使うと CollectionView のパフォーマンスが崖から落ちるように悪化します。

**検証**: Android 向けにビルドし (`dotnet build -t:Run -f net11.0-android35.0`)、ミドルレンジの端末で 1000 件のリストをスクロールします。Android Studio の Profile GPU Rendering ビューでフレームタイムが 16 ms 未満であるべきです。そうでない場合は、`x:DataType` が設定されていること、テンプレート内のバインディングが `Source={x:Reference ...}` を使っていないことを確認してください。

### 2. プルツーリフレッシュのために `RefreshView` でラップする

`IsPullToRefreshEnabled`、`IsRefreshing`、`RefreshCommand` はもうリストにはありません。これらは `RefreshView` 上にあり、スクロール可能な任意のコンテンツをラップします。

```xml
<!-- After. .NET MAUI 11.0 -->
<RefreshView IsRefreshing="{Binding IsRefreshing}"
             Command="{Binding RefreshCommand}">
    <CollectionView ItemsSource="{Binding Articles}"
                    SelectionMode="Single">
        <CollectionView.ItemTemplate>
            <DataTemplate x:DataType="vm:ArticleVm">
                <!-- as before -->
            </DataTemplate>
        </CollectionView.ItemTemplate>
    </CollectionView>
</RefreshView>
```

`RefreshView` はラップしたスクロール可能要素がオフセット 0 のときにのみ発火するので、挙動は古い `ListView` と一致します。`IsPullToRefreshEnabled` はないので、無効にしたい場合は `RefreshView` の `IsEnabled="False"` を設定してください。

**検証**: オフセット 0 でリストを下に引きます。プラットフォームのスピナーが現れ、`RefreshCommand` がジェスチャーごとに正確に 1 回発火するはずです。

### 3. 選択を書き直す

Xamarin.Forms の `ItemTapped` イベントは `SelectedItem` が変わらないときでもタップごとに発火します。CollectionView はこれを明確に分けます。タップは選択であり、選択は `SelectionChanged` または `SelectionChangedCommand` を通して観測可能です。同じ項目に 2 回連続でタップしてナビゲートする挙動に依存していた場合は、毎回ナビゲーション後に `SelectedItem` を読んでクリアすることで選択状態をオプトアウトする必要があります。

```csharp
// MainViewModel.cs, .NET MAUI 11.0, C# 14
[RelayCommand]
private async Task OpenArticleAsync(ArticleVm? selected)
{
    if (selected is null) return;
    await Shell.Current.GoToAsync(nameof(ArticleDetailPage),
        new Dictionary<string, object> { ["article"] = selected });
    SelectedArticle = null; // re-arm so the same row can fire next time
}
```

`SelectionMode="None"` プラスでテンプレート内の `TapGestureRecognizer` が、古い `ItemTapped` のセマンティクスに最も近い相当品です。理由がある場合のみ使ってください。プラットフォーム側が期待しているのは選択ベースのパターンであり、Windows ではアクセシビリティのフォーカスリングを無料で得られます。

**検証**: 項目をタップし、戻り、同じ項目をタップします。両方のタップで詳細ページが開くはずです。

### 4. `ContextActions` を `SwipeView` に置き換える

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ViewCell>
    <ViewCell.ContextActions>
        <MenuItem Text="Delete" IsDestructive="True"
                  Command="{Binding DeleteCommand}" />
    </ViewCell.ContextActions>
    <Grid>...</Grid>
</ViewCell>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<SwipeView>
    <SwipeView.RightItems>
        <SwipeItems Mode="Execute">
            <SwipeItem Text="Delete"
                       BackgroundColor="Crimson"
                       Command="{Binding DeleteCommand}" />
        </SwipeItems>
    </SwipeView.RightItems>
    <Grid>...</Grid>
</SwipeView>
```

`SwipeView` はカスタム背景を持つ実物の左右スワイプです。`IsDestructive` は通常の `BackgroundColor` になります。`Mode="Execute"` はタップで自動的に閉じる古い挙動に対応し、`Mode="Reveal"` はメニューを開いたままにします。iOS の長押しでメニューを表示する機能はなくなりました。必要なら MAUI 11 の `MenuFlyout` (本リリースでの新機能) を使ってください。

**検証**: iOS と Android で左にスワイプします。delete をタップします。項目が削除されます。次の行で再度スワイプし、同時に開いているスワイプが常に 1 つだけであることを確認します。

### 5. グルーピングを切り替える

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding ArticlesByDay}"
                IsGrouped="True">
    <CollectionView.GroupHeaderTemplate>
        <DataTemplate x:DataType="vm:ArticleDayVm">
            <Label Text="{Binding Day, StringFormat='{0:D}'}"
                   FontAttributes="Bold"
                   Padding="12,8" />
        </DataTemplate>
    </CollectionView.GroupHeaderTemplate>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <!-- as before -->
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

変わるのは 2 点です。フラグは `IsGroupingEnabled` ではなく `IsGrouped` です。そしてソースは、各外側の項目自体が列挙可能なコレクションのコレクションでなければなりません。最もきれいなパターンは、`List<TItem>` から派生し `Key` を公開する `Grouping<TKey, TItem>` クラスです。これは Xamarin.Forms が使っていたのと同じパターンで、そのまま移植できます。

**検証**: 30 日分のグループ化されたリストをスクロールします。iOS ではグループヘッダーがデフォルトでグループの先頭に貼り付くはずです (iOS ネイティブの `GroupHeadersStick="True"` であり、MAUI のデフォルトもこれを反映しています)。

### 6. `ItemsLayout` を選ぶ

デフォルトは垂直の `LinearItemsLayout` で、これは `ListView` と一致します。1 行のグリッドに切り替えるには次のようにします。

```xml
<CollectionView ItemsSource="{Binding Photos}">
    <CollectionView.ItemsLayout>
        <GridItemsLayout Orientation="Vertical"
                         Span="3"
                         HorizontalItemSpacing="4"
                         VerticalItemSpacing="4" />
    </CollectionView.ItemsLayout>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:PhotoVm">
            <Image Source="{Binding ThumbnailUrl}" Aspect="AspectFill" />
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

`Span="3"` は固定の列数です。組み込みのアダプティブグリッドはありません。それが必要なら、ビヘイビアで利用可能な幅に対してセルをサイジングするか、サイズ変更時に再バインドします。

**検証**: 端末を回転します。グリッドはスクロール位置を失わずに再描画されるはずです。

### 7. `EmptyView` を追加する

```xml
<CollectionView ItemsSource="{Binding Articles}">
    <CollectionView.EmptyView>
        <VerticalStackLayout HorizontalOptions="Center"
                             VerticalOptions="Center" Spacing="8">
            <Label Text="No articles yet" FontSize="18" />
            <Button Text="Refresh" Command="{Binding RefreshCommand}" />
        </VerticalStackLayout>
    </CollectionView.EmptyView>
</CollectionView>
```

複数の空状態 (データなし vs エラー) には、`EmptyView` をプロパティにバインドし、`DataTemplateSelector` 付きの `EmptyViewTemplate` を使ってください。

**検証**: ソースをクリアします。empty ビューが表示されます。ソースを再充填します。フレームの重なりなしに empty ビューが消えます。

## 検証チェックリスト

すべてのリストを移行した後に行います。

- `dotnet build -c Release` を `net11.0-android35.0`、`net11.0-ios18.0`、`net11.0-maccatalyst18.0`、`net11.0-windows10.0.19041.0` に対して実行したとき、非推奨の `ListView` API に関する警告がゼロであること。
- ViewModel レイヤーに対する `dotnet test` が緑色であること。選択ロジックは最も回帰しやすい箇所なので、カバーしてください。
- Android 上で、Pixel 6 か同等の端末で 1000 件のリストをスクロールします。行が均一なら `MeasureFirstItem` でフレームタイムは 16 ms 未満を保ちます。`MeasureAllItems` と 1000 件では、初回表示時に一度だけ測定コストがかかることを見込んでください。
- iOS 上で、行に指を置きます。`SelectionMode="None"` の場合、離した後に選択フィードバックが残るべきではありません。
- プルツーリフレッシュは、すべてのプラットフォームでジェスチャーごとに正確に 1 回発火します。
- スワイプアクションは正しい側で表示されます (RTL 言語は自動でミラーされます。出荷するならアラビア語ロケールで検証してください)。
- `EmptyView` が VoiceOver / TalkBack で読み上げられます。CollectionView は空状態のアクセシビリティテキストを自動で出荷します。手動の `SemanticProperties.Description` がそれを上書きします。

## ロールバック計画

これは実質的に一方向の移行です。プロジェクトが `net11.0-*` のターゲットフレームワークと `MauiProgram.cs` に乗ったあとに Xamarin.Forms に戻すには、古い `csproj` の形、`Xamarin.Forms.Forms.Init`、プラットフォーム固有のアプリエントリポイントを復元する必要があります。本稿の CollectionView 自体に関する内容は、プロジェクトのアップグレードと別に取り消せるものはありません。Xamarin.Forms ブランチを削除する前に、動作する MAUI ビルドを出荷する計画にしてください。

## 私たちが踏んだ落とし穴

- `ItemTapped` のセマンティクス。古いコードが同じ行を 2 回タップ可能にするために `ItemTapped` の中で `ListView.SelectedItem = null` を呼んでいた場合、毎回ナビゲーション後に `SelectedItem` (または `SelectedItems`) をクリアし続ける必要があります。CollectionView は自動でクリアしません。
- 無限スクロール用の `RemainingItemsThreshold` は CollectionView 上にあります (`RemainingItemsThreshold` プラス `RemainingItemsThresholdReachedCommand`)。古い `ItemAppearing` パターンも依然として動きますが、項目ごとに発火します。しきい値パターンは末尾近くで一度だけ発火し、これがほとんどの無限スクロール UI が実際に望むものです。
- `ScrollTo` は `ScrollToPosition` 列挙体の `MakeVisible` 値を取らなくなりました。最も近いマッピングは `ScrollToPosition.MakeVisible` から `ScrollToPosition.MakeVisible` (同じ名前、同じ列挙体) ですが、第 2 引数はグループインデックスになりました。グループ化されていないリストには `null` を渡します。カスタムスクロールロジックを移植する前に [CollectionView ScrollTo のドキュメント](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/scrolling)を読んでください。
- コンパイル済みバインディング (`x:DataType`) はパフォーマンスのため必須です。これがないと Android ではすべてのバインディングがリサイクル時にリフレクションで解決されるためスクロールがガタつきます。
- 可変高さの長いリストでの `ItemSizingStrategy.MeasureAllItems` は、初回表示時に 1 回フルの測定パスを強制します。1 万件あってリストが画面の最初の要素なら、time-to-first-frame が悪化します。可能なときは固定のセル高さを使ってください。
- カスタムの `ViewCell` レンダラーは移植できません。MAUI には `ViewCellRenderer` はありません。持っていた場合、セルは MAUI では通常のレイアウトになり、レンダラーのロジックはそれを必要としていた子コントロール上の[ハンドラー](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/)に移動します。
- `TableView` は静的な設定スタイルの画面のために MAUI に依然として存在します。動的なデータには使わないでください。仮想化されません。

## 関連記事

- [MAUI アプリでダークモードを正しくサポートする方法](/ja/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) では、CollectionView 内のテンプレートに必要な `AppThemeBinding` パターンを扱っています。
- [MAUI 11 でドラッグアンドドロップを実装する方法](/ja/2026/05/how-to-implement-drag-and-drop-in-maui-11/) では、`DragGestureRecognizer` と `CollectionView` の項目を組み合わせる方法を示しています。これは ListView の並べ替えの現代的な代替です。
- [MAUI アプリを Microsoft Store 向けにパッケージングする方法](/ja/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) は、移行が完了して再び Windows に出荷したくなったときの次のステップです。
- [Windows と macOS のみで動く MAUI アプリの書き方](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) は、Xamarin.Forms プロジェクトから同時にモバイルを切り捨てるなら適切な参考資料です。

## 出典

- [.NET MAUI CollectionView のドキュメント](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/)
- [.NET MAUI ListView のドキュメント](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview)
- [Xamarin.Forms サポートポリシー](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)
- MS Learn の [Xamarin.Forms からのアップグレード](https://learn.microsoft.com/en-us/dotnet/maui/migration/)
- [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)

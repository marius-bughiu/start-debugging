---
title: ".NET MAUI 11 でドラッグアンドドロップを実装する方法"
description: ".NET MAUI 11 でのエンドツーエンドのドラッグアンドドロップ：DragGestureRecognizer、DropGestureRecognizer、カスタム DataPackage ペイロード、AcceptedOperation、ジェスチャー位置、Android、iOS、Mac Catalyst、Windows のプラットフォーム別 PlatformArgs の落とし穴。"
pubDate: 2026-05-03
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "drag-and-drop"
  - "gestures"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-implement-drag-and-drop-in-maui-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

短い答え：.NET MAUI 11 では、ソース `View` に `DragGestureRecognizer` を、ターゲット `View` に `DropGestureRecognizer` をそれぞれの `GestureRecognizers` コレクションを通じて取り付けます。組み込みコントロール（`Label`、`Entry`、`Image`、`Button` など）のテキストや画像については、フレームワークが `DataPackage` を自動的に配線するので、ドロップされた値が自動的に届きます。それ以外のものについては、`DragStarting` ハンドラーで `e.Data` を設定し、`Drop` ハンドラーで `e.Data`（`DataPackageView`）から読み取ります。`DragOver` で `e.AcceptedOperation = DataPackageOperation.Copy` または `None` を設定してカーソルを制御し、カスタムドラッグプレビュー、Move 操作、または別アプリからドロップされたファイルの読み取りが必要なときは `e.PlatformArgs` に降りていきます。

この投稿では、.NET MAUI 11.0.0 と .NET 11 で実行可能な XAML と C# を使って API の全体を解説します。公式ドキュメントが触れない部分も含みます：`DataPackagePropertySet` がマネージドオブジェクトを実際にどう運ぶのか、なぜ Move 操作が Android で静かに Copy にダウングレードされるのか、なぜ 2 回目のドラッグでカスタムシェイプが `null` になるのか、そして Explorer や Photos からドロップが来たときのファイルパスの読み取り方。以下の内容はすべて、.NET 11 SDK の `dotnet new maui` と `Microsoft.Maui.Controls` 11.0.0 で検証済みです。

## なぜ MAUI のドラッグアンドドロップは見た目より興味深いのか

2 つのジェスチャー認識器、`DragGestureRecognizer` と `DropGestureRecognizer` は Xamarin.Forms 5 から継承されたもので、MAUI のごく初期のリリースから箱に入っています。API の形は MAUI 11 でも変わっていませんが、プラットフォーム別の事情は意味のある形で改善されています：MAUI 9 で着地した `PlatformArgs` プロパティが、サポートされている 4 つのヘッドすべてで安定しました。これにより、ようやくカスタムハンドラーに降りずに、iOS でのカスタムドラッグプレビュー、Windows Explorer からの複数ファイルドロップ、Mac Catalyst での `UIDropOperation.Move` のようなことができるようになりました。

コードを書く前に内面化しておくべきこと：ジェスチャー認識器は、4 つの非常に異なるネイティブシステムに対する MAUI の抽象化です。Android は `View.startDragAndDrop` と `ClipData` を使い、iOS と Mac Catalyst は `UIDragInteraction` と `NSItemProvider` を使い、Windows は `FrameworkElement` 上の WinRT `DragDrop` インフラを使います。クロスプラットフォームの `DataPackage` は、テキスト、画像、`Dictionary<string, object>` のプロパティバッグを運びます。そのプロパティバッグに入れたものは何でも**プロセスローカル**です。なぜなら、下層のネイティブシステムはアプリケーションの境界を越えてテキスト、画像、ファイル URI しかマーシャルできないからです。これは、開発者がアプリ内ドラッグからアプリ間ドラッグに移行するときの最大の驚きの源です。

Xamerin.Forms から来た方なら、既存のハンドラーは何も変更する必要がありません。クラス名、イベントシグネチャ、`DataPackageOperation` 列挙型はバイト単位で同一です。`PlatformArgs` の話だけが新しく、それ以外は 2020 年に出荷されたのと同じコードです。

## テキスト Label をドラッグして Entry にドロップする

最小の有用なケースから始めましょう：`Label` からテキスト値をドラッグして `Entry` にドロップします。両方とも組み込みのテキストコントロールなので、MAUI が `DataPackage` を自動的に詰めて読み戻します。機能全体が XAML だけで完結します。

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<VerticalStackLayout Padding="20" Spacing="20">
    <Label Text="Drag this label"
           FontSize="20">
        <Label.GestureRecognizers>
            <DragGestureRecognizer />
        </Label.GestureRecognizers>
    </Label>

    <Entry Placeholder="Drop here">
        <Entry.GestureRecognizers>
            <DropGestureRecognizer />
        </Entry.GestureRecognizers>
    </Entry>
</VerticalStackLayout>
```

ドラッグジェスチャーは、タッチプラットフォームでは long-press のあとにドラッグで開始し、Windows と Mac Catalyst では通常の mouse-down-and-move で開始します。code-behind は不要です：MAUI は出ていくときに `Label.Text` を `DataPackage.Text` に読み込み、入ってくるときに `DataPackage.Text` を `Entry.Text` に書き込みます。

同じ自動配線が、ソース側とデスティネーション側の両方で `CheckBox.IsChecked`、`DatePicker.Date`、`Editor.Text`、`RadioButton.IsChecked`、`Switch.IsToggled`、`TimePicker.Time` をカバーし、`Button`、`Image`、`ImageButton` の画像もカバーします。ブール値と日付は `string` のラウンドトリップで変換されるので、不正な形式のドロップ（テキスト "yes" を `CheckBox` にドラッグするなど）は静かに `IsChecked` の切り替えに失敗します。

## カードを 2 つの列の間で移動する

興味深いのは自分の UI のケース：列の間でドラッグしたいカードを持つボードです。`DataPackage` はマネージドオブジェクトをプロセス間で運べませんが、アプリ内ドラッグでは `Properties` を通じて間違いなく運べます。

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Grid ColumnDefinitions="*,*" Padding="20" ColumnSpacing="20">
    <VerticalStackLayout x:Name="TodoColumn" Grid.Column="0" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="To do" FontAttributes="Bold" />
    </VerticalStackLayout>

    <VerticalStackLayout x:Name="DoneColumn" Grid.Column="1" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="Done" FontAttributes="Bold" />
    </VerticalStackLayout>
</Grid>
```

各カードはコードで構築され、それぞれ独自の `DragGestureRecognizer` を受け取ります：

```csharp
// .NET MAUI 11.0.0, .NET 11
public record Card(Guid Id, string Title);

Border BuildCardView(Card card)
{
    var border = new Border
    {
        Padding = 12,
        StrokeThickness = 1,
        BindingContext = card,
        Content = new Label { Text = card.Title }
    };

    var drag = new DragGestureRecognizer();
    drag.DragStarting += (s, e) =>
    {
        e.Data.Properties["Card"] = card;
        e.Data.Text = card.Title; // fallback for inter-app drops
    };
    border.GestureRecognizers.Add(drag);

    return border;
}
```

`DragStarting` イベントは `DragStartingEventArgs` を受け取り、その `Data` プロパティはドラッグごとに新しい `DataPackage` です。`e.Data.Properties["Card"]` を設定すると、実際の `Card` 参照が `Dictionary<string, object>` に格納されます。ドロップ側では同じディクショナリにアクセスします：

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    e.AcceptedOperation = e.Data.Properties.ContainsKey("Card")
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}

void OnDrop(object sender, DropEventArgs e)
{
    if (e.Data.Properties.TryGetValue("Card", out var value) && value is Card card)
    {
        var targetColumn = (VerticalStackLayout)sender;
        MoveCard(card, targetColumn);
        e.Handled = true;
    }
}
```

ここでは目立たない 2 つのことが起きています。

1 つ目、`DropEventArgs` の `e.Data` は `DataPackage` ではなく `DataPackageView` です。意図的に読み取り専用です：ドロップターゲットはパッケージを変更できません。`Properties`（`DataPackagePropertySetView`）を読み、定義済みのテキストおよび画像スロットには `await e.Data.GetTextAsync()` または `await e.Data.GetImageAsync()` を呼び出します。非同期メソッドはそれぞれ `Task<string?>` と `Task<ImageSource?>` を返します。

2 つ目、`Drop` ハンドラーで `e.Handled = true` を設定すると、MAUI にデフォルトの動作を適用しないように指示します。これはドロップターゲットが `Label` や `Image` のときに重要です。そうしないと、MAUI が*さらに*手動で行ったことの上にデータパッケージからテキストや画像を設定しようとし、追跡が痛い二重更新バグにつながります。

## 正しい `AcceptedOperation` を選ぶ

`DragOver` イベントは、ポインターがドロップターゲットの上にある間、継続的に発火します。その役割は `e.AcceptedOperation` を設定することで、これが Windows と Mac Catalyst のカーソル表示と iOS のシステムフィードバックを決定します。`DataPackageOperation` 列挙型には MAUI に同梱される値がちょうど 2 つあります：`Copy` と `None`。`Move` も `Link` もフラグの組み合わせもありません。`Windows.ApplicationModel.DataTransfer` を参照していて IntelliSense が何を提案しても関係ありません。

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    var canAccept = e.Data.Properties.ContainsKey("Card");
    e.AcceptedOperation = canAccept
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}
```

`DragEventArgs` が構築されると、`AcceptedOperation` はデフォルトで `Copy` になります。すべてのドロップを拒否する列（たとえば、表示モードのときの読み取り専用「アーカイブ」列）が欲しい場合は、`DragOver` で能動的に `None` に設定する必要があります。これを忘れることが、ターゲットが誤って何でも受け入れる最も一般的な理由です。

iOS と Mac Catalyst で Move セマンティクスを得るには（システムが Copy と Move を見えるバッジで実際に区別する場所）、`PlatformArgs` に降りていきます：

```csharp
// .NET MAUI 11.0.0, .NET 11, iOS / Mac Catalyst
void OnDragOver(object sender, DragEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetDropProposal(
        new UIKit.UIDropProposal(UIKit.UIDropOperation.Move));
#endif
}
```

Android では、ドラッグアンドドロップはアプリ間レイヤーで Copy 対 Move の区別を持たないので、`AcceptedOperation` プロパティはアプリ内のアフォーダンスのみを制御します。Windows では、`Copy` 対 `None` のカーソルは `AcceptedOperation` から直接駆動されます。

## ドラッグプレビューをカスタマイズする

デフォルトのドラッグプレビューはソースビューのスナップショットで、通常はそれで問題ありません。そうでない場合、各プラットフォームは `PlatformArgs` を通じて独自のプレビューフックを公開します。

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragStarting(object sender, DragStartingEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetPreviewProvider(() =>
    {
        var image = UIKit.UIImage.FromFile("dotnet_bot.png");
        var imageView = new UIKit.UIImageView(image)
        {
            Frame = new CoreGraphics.CGRect(0, 0, 200, 200),
            ContentMode = UIKit.UIViewContentMode.ScaleAspectFit
        };
        return new UIKit.UIDragPreview(imageView);
    });
#elif ANDROID
    var view = (Android.Views.View)((Microsoft.Maui.Controls.View)sender).Handler!.PlatformView!;
    e.PlatformArgs?.SetDragShadowBuilder(new Android.Views.View.DragShadowBuilder(view));
#endif
}
```

Android では `SetDragShadowBuilder` が指に追従する影を制御します。iOS と Mac Catalyst では `SetPreviewProvider` が `UIDragPreview` を返します。Windows では `e.PlatformArgs.DragStartingEventArgs.DragUI` のプロパティを設定し、MAUI が変更を上書きしないように `e.PlatformArgs.Handled = true` を設定するのを忘れないでください。

その `Handled` フラグは API 全体で最も簡単な落とし穴です：Windows では、各 `PlatformArgs` は WinRT イベント引数オブジェクトの薄いシムであり、設定したプロパティは、platform args 自身に `Handled = true` を設定しない限り、MAUI のデフォルトの配線によって静かに上書きされます（これは MAUI レベルの処理を制御する `DragEventArgs.Handled` や `DropEventArgs.Handled` とは別物です）。

## ドロップの位置を取得する

MAUI 11 では、3 つのイベント引数すべて（`DragStartingEventArgs`、`DragEventArgs`、`DropEventArgs`）が `Point?` を返す `GetPosition(Element?)` メソッドを公開しています。スクリーン座標には `null` を渡すか、その要素に対する相対座標を取得するために要素を渡します。

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDrop(object sender, DropEventArgs e)
{
    var canvas = (Layout)sender;
    var point = e.GetPosition(canvas);
    if (point is { } p)
    {
        AbsoluteLayout.SetLayoutBounds(_draggedView!,
            new Rect(p.X, p.Y, AbsoluteLayout.AutoSize, AbsoluteLayout.AutoSize));
    }
}
```

Android の `PlatformArgs.DragEvent` から `MotionEvent.GetX/Y` を読み、iOS の `DropSession` から `LocationInView` を読むという昔の回避策を覚えていても、もう必要ありません。`GetPosition` が `null` を返すのは、プラットフォームが本当に位置を報告しなかったときだけです（まれですが、nullable は重要なものとして扱ってください）。

## 別のアプリケーションからファイルを受け取る

アプリ間ドラッグは iOS、Mac Catalyst、Windows でサポートされています。Android は、ジェスチャー認識器 API を通じて別のアプリのアイテムのドロップターゲットになることはできません。

データの形はプラットフォーム固有です。プロセス間ペイロードは常にネイティブだからです：iOS と Mac Catalyst では `UIDragItem` のコレクション、Windows では `DataPackageView`。MAUI は `PlatformArgs` を通じてネイティブオブジェクトを渡してくれます。

```csharp
// .NET MAUI 11.0.0, .NET 11, Windows
async void OnDrop(object sender, DropEventArgs e)
{
#if WINDOWS
    var view = e.PlatformArgs?.DragEventArgs.DataView;
    if (view is null || !view.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
        return;

    var items = await view.GetStorageItemsAsync();
    foreach (var item in items)
    {
        if (item is Windows.Storage.StorageFile file)
            HandleDroppedFile(file.Path);
    }
#endif
}
```

iOS/Mac Catalyst の派生形は `e.PlatformArgs.DropSession.Items` を使い、各 `NSItemProvider` に in-place ファイル表現をロードするよう求めます。.NET MAUI サンプルからの完全なパターンは Microsoft Learn の [Drag and drop between applications](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0#drag-and-drop-between-applications) に文書化されています。

両プラットフォームについて、`Drop` ハンドラーは UI スレッドで実行され、ファイルはまだコピーされていません。バイトが必要な場合は、戻る前にハンドラー内でコピーしてください。ハンドラーが完了したらすぐにソースアプリがドラッグセッションを取り消すことが許可されているからです。

## 半日を食う 5 つの落とし穴

**1. `DataPackage` はシングルショット。** 各ドラッグジェスチャーは新しい `DataPackage` を作成します。`e.Data` をキャッシュして別のドロップから後で読み取ろうとすると、現在のドラッグではなく*元の*ドラッグからのデータが返ります。これが「2 番目にドラッグしたカードがおかしい」バグの原因です。

**2. `Properties` はプロセスローカル。** `e.Data.Properties` に入れるものは、アプリ内では完璧に動作し、アプリケーション間では見えません。アプリ間ドロップを生き延びるペイロードが必要なら、`e.Data.Text` も設定してください（または Android では `PlatformArgs.SetClipData`、iOS では `SetItemProvider` に書き込んでください）。システムにマーシャル可能な具体的なものを与えるためです。

**3. `Label`/`Image`/`Entry` のデフォルトドロップは常に発火する。** `Drop` を処理してターゲットを手動で更新する場合は、`e.Handled = true` を設定してください。そうしないと、MAUI の自動的なテキストまたは画像の代入があなたのハンドラーの後に実行され、結果を上書きします。

**4. `DropGestureRecognizer` はバブルしない。** 各ビジュアル要素は認識器を持つか持たないかのどちらかです。親 `Grid` に認識器を置き、子の `Border` に独自の認識器がない場合、ジェスチャーは期待通りに動作します。しかし、子に他のジェスチャー認識器がある場合、ドロップのヒットテストが子に着地して親をスキップする可能性があります。明示的にしましょう：ドロップを受け入れるべき最も深い要素にドロップ認識器を置きます。

**5. Android のドラッグアンドドロップは、ヒットテストに参加する `View` を必要とする。** `InputTransparent="True"` を持つ `Label` は静かにドラッグの開始を拒否し、背景色のない `BoxView` は、ラスタライザーが実際に塗る矩形上のジェスチャーしかインターセプトしません。Android でドラッグが始まらない場合は、`Handler` のオーバーライドに手を伸ばす前のサニティチェックとして、ソースビューに `BackgroundColor` を設定してください。

## より豊かなインタラクションのための構成要素

ドラッグアンドドロップは、デスクトップやタブレットの MAUI アプリに直接操作を追加する最も摩擦の少ない方法ですが、ジェスチャー認識器は、並べ替え可能なリスト、tab-tear-out ウィンドウ、Trello スタイルのボードを書くときに手を伸ばす構成要素でもあります。これらのどれも今日は単一のライブラリコントロールに合成されないので、すべての真剣な MAUI デスクトップアプリは独自に書きます。良いニュースは、下層の API が十分に小さく、「独自に書く」が通常 100 行のコードを意味することです。そのほとんどはジェスチャー処理自体ではなく、プラットフォーム固有のプレビューカスタマイズです。

デスクトップ専用の MAUI ヘッドを構築している場合、[Windows と macOS のみの MAUI 11 セットアップ](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) の残りの部分が、`dotnet build` が Android と iOS のワークロードを引きずらないようにモバイルのターゲットフレームワークを剥ぎ取る方法を解説します。フレームワークの他の新機能のツアーには、この投稿が依存する `PlatformArgs` の追加をカバーする [.NET MAUI 10 の新機能](/ja/2025/04/whats-new-in-net-maui-10/) を参照してください。ドラッグプレビューに表示されるテーマ色を上書きする必要がある場合、[.NET MAUI で SearchBar のアイコンの色を変更する方法](/ja/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) と同じハンドラーパターンが、ほとんどのネイティブプレビュー調整に一般化されます。そして、これらのジェスチャーをホストするクラスライブラリがアプリの場合、[MAUI ライブラリでハンドラーを登録する方法](/ja/2023/11/maui-library-register-handlers/) が、認識器が消費アプリの起動時に実際にアタッチされるために必要な `MauiAppBuilder` の配線をカバーします。

## 参考リンク

- [Recognize a drag and drop gesture - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0)
- [DragGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.draggesturerecognizer)
- [DropGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.dropgesturerecognizer)
- [DataPackage Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.datapackage)
- [.NET MAUI Drag and Drop Gesture sample](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/gestures-draganddropgesture/)

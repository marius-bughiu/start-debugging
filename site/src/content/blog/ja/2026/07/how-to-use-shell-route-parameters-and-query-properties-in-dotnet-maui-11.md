---
title: ".NET MAUI 11 で Shell のルートパラメーターと query properties を使ってナビゲーションする方法"
description: ".NET MAUI 11 の Shell ナビゲーションでデータを渡すための完全ガイドです。グローバルルートの登録、文字列のクエリパラメーター、QueryPropertyAttribute と IQueryAttributable の比較、両者の URL デコードの非対称性、単回使用の ShellNavigationQueryParameters とメモリを保持する IDictionary オーバーロードの違い、..?key=value による後方へのデータ受け渡し、そして QueryPropertyAttribute がトリミング安全でない理由を扱います。"
pubDate: 2026-07-28
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "shell"
  - "navigation"
  - "how-to"
lang: "ja"
translationOf: "2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-07-28
---

.NET MAUI 11 の Shell ナビゲーションでページにデータを渡すには、遷移先ページを `Routing.RegisterRoute("details", typeof(DetailPage))` でグローバルルートとして登録し、`await Shell.Current.GoToAsync($"details?id={id}")` で遷移して、受け取り側のクラスに `[QueryProperty(nameof(Id), "id")]` を付けるか `IQueryAttributable.ApplyQueryAttributes` を実装して値を受け取ります。おすすめは `IQueryAttributable` です。`QueryPropertyAttribute` はトリミング安全ではなく、完全トリミングや Native AOT では動作しません。文字列以外のものを渡す場合は、`IDictionary<string, object>` のオーバーロードではなく `GoToAsync(string, ShellNavigationQueryParameters)` を使ってください。ディクショナリ版はページの生存期間中ずっとオブジェクトを保持し続けるからです。

この記事は .NET MAUI 11 (執筆時点では Preview 6、GA は 2026 年 11 月) と C# 14 を対象にしています。Shell のナビゲーション API は .NET MAUI 8 以降安定しているため、最後の .NET 11 固有の項目を除けば、.NET MAUI 8、9、10 にもそのまま当てはまります。

## Shell が URI をページに変換する仕組み

Shell のナビゲーションは URI ベースです。完全なナビゲーション URI は `//route/page?queryParameters` という形をとり、3 つの要素で構成されます。

- **ルート**は Shell のビジュアル階層への経路で、`FlyoutItem`、`TabBar`、`Tab`、`ShellContent` に設定した `Route` プロパティから組み立てられます。
- **ページ**はビジュアル階層に存在せず、必要に応じてナビゲーションスタックにプッシュされるものです。詳細ページはほぼ常にこちらです。
- **クエリパラメーター**は末尾の `?key=value&key2=value2` の部分です。

この区別は見た目以上に重要です。2 種類の遷移先は正反対のルールに従うからです。

| | `AppShell.xaml` で宣言 | `Routing.RegisterRoute` で登録 |
| --- | --- | --- |
| 到達方法 | 絶対ルート、`//animals/monkeys` | 相対ルート、`monkeydetails` |
| ナビゲーションスタックを作る | いいえ | はい |
| もう一方の形式で動くか | 絶対のみ | 相対のみ |

絶対ルートは `Routing.RegisterRoute` で登録したページには効きませんし、相対ルートは `Shell` サブクラス内で宣言したページには効きません。この 2 つを取り違えることが、正しく見える `GoToAsync` 呼び出しで `ArgumentException` が出る最大の原因です。

## 詳細ページへのルートを 5 ステップで用意する

1. **Shell の各要素に明示的なルートを付けます。** 階層内のすべての要素は、設定してもしなくてもルートを持ちますが、自動生成されたルートはアプリのセッションをまたいで一貫する保証がないため、決して依存しないでください。

   ```xml
   <!-- AppShell.xaml, .NET MAUI 11 -->
   <Shell xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
          x:Class="OrdersApp.AppShell">
       <TabBar>
           <ShellContent Title="Orders"
                         Route="orders"
                         ContentTemplate="{DataTemplate local:OrdersPage}" />
           <ShellContent Title="Settings"
                         Route="settings"
                         ContentTemplate="{DataTemplate local:SettingsPage}" />
       </TabBar>
   </Shell>
   ```

2. **詳細ページをグローバルルートとして登録します。** `Shell` サブクラスのコンストラクターか、そのルートが初めて呼ばれる前に実行される任意の場所で行います。

   ```csharp
   // AppShell.xaml.cs, .NET MAUI 11
   public partial class AppShell : Shell
   {
       public AppShell()
       {
           InitializeComponent();
           Routing.RegisterRoute("orderdetails", typeof(OrderDetailPage));
       }
   }
   ```

   同じルート文字列を 2 つの異なる型に登録すると `ArgumentException` が発生します。起動時にビジュアル階層で重複ルートが検出された場合も同様です。

3. **ページとその view model を DI コンテナーに登録します。** これで Shell が依存関係とともにインスタンスを構築できます。

   ```csharp
   // MauiProgram.cs, .NET MAUI 11
   builder.Services.AddTransient<OrderDetailPage>();
   builder.Services.AddTransient<OrderDetailViewModel>();
   ```

4. **`BindingContext` はページのコンストラクターで設定します。** `OnAppearing` ではいけません。Shell はページを構築した直後、`OnAppearing` が走るよりずっと前に、ページ*と*その `BindingContext` の両方に query attributes を適用します。後から割り当てた view model はパラメーターを受け取れません。

   ```csharp
   public partial class OrderDetailPage : ContentPage
   {
       public OrderDetailPage(OrderDetailViewModel vm)
       {
           InitializeComponent();
           BindingContext = vm;   // must happen here
       }
   }
   ```

5. **遷移する際は必ず `await` してください。** 待機しないナビゲーションは競合状態になります。呼び出しのあとのコードがナビゲーション完了前に実行されてしまい、クエリパラメーターが欠落する、`Shell.Current.CurrentPage` が古いままになる、あるいはナビゲーションが黙って何もしない、といった形で現れます。

   ```csharp
   // Correct
   await Shell.Current.GoToAsync($"orderdetails?id={order.Id}");

   // Wrong: race condition
   Shell.Current.GoToAsync($"orderdetails?id={order.Id}");
   ```

## 文字列パラメーターの受け取り方：2 つの API と 1 つの重要な違い

どちらの受け取り方法も、ページクラスと `BindingContext` に使われるクラスの両方で機能します。

`QueryPropertyAttribute` はクエリパラメーターの id を 1 つのプロパティに対応づけます。第 1 引数がプロパティ名、第 2 引数が URI 内のパラメーター id です。

```csharp
// .NET MAUI 11, C# 14
[QueryProperty(nameof(OrderId), "id")]
[QueryProperty(nameof(CustomerName), "customer")]
public partial class OrderDetailPage : ContentPage
{
    public string OrderId { set => LoadOrder(value); }
    public string CustomerName { set => Title = value; }
}
```

`IQueryAttributable` はすべてを 1 つのディクショナリで渡してくれます。2 つのパラメーターをまとめて検証する必要が出た時点で、こちらが欲しくなります。

```csharp
// .NET MAUI 11, C# 14
public partial class OrderDetailViewModel : ObservableObject, IQueryAttributable
{
    [ObservableProperty]
    private Order? _order;

    public void ApplyQueryAttributes(IDictionary<string, object> query)
    {
        if (!query.TryGetValue("id", out var raw) || !int.TryParse(raw?.ToString(), out var id))
            return;

        var customer = HttpUtility.UrlDecode(query["customer"].ToString());
        Order = _repository.Load(id, customer);
    }
}
```

`HttpUtility.UrlDecode` の呼び出しに注目してください。ここに半日を溶かす非対称性があります。**`QueryPropertyAttribute` 経由で受け取った文字列のクエリパラメーター値は自動的に URL デコードされますが、`IQueryAttributable` 経由で受け取った値はデコードされません。** デコード処理を足さずに属性からインターフェースへ乗り換えると、`Acme%20Corp` がそのまま `Acme%20Corp` という文字列として UI に出ます。

送信側の対応するルールは、`&`、`?`、`#`、`=`、空白を含みうるものはすべてエンコードすることです。

```csharp
// .NET MAUI 11, C# 14
var url = $"orderdetails?id={order.Id}&customer={Uri.EscapeDataString(order.CustomerName)}";
await Shell.Current.GoToAsync(url);
```

`Uri.EscapeDataString` がないと、"Smith & Sons" という顧客名はアンパサンドの位置でパラメーターが途切れ、`Sons` という幽霊パラメーターが黙って生成されます。

## オブジェクトを渡す、そしてメモリを保持するオーバーロード

識別子を渡すだけなら文字列パラメーターで十分です。もっと豊かなデータには 2 つのオーバーロードがあり、その挙動は大きく異なります。

`IDictionary<string, object>` のオーバーロードは**複数回使用**のデータを渡します。

```csharp
// .NET MAUI 11, C# 14
var parameters = new Dictionary<string, object> { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

この方法で渡したデータはページの生存期間中メモリに保持され、ページがナビゲーションスタックから外れるまで解放されません。さらに戻る際にも再配信されます。`Page1` が `MyData` を `Page2` に渡し、`Page2` が `Page3` をプッシュした場合、`Page3` をポップすると `Page2` は再び `MyData` を受け取ります。この再配信はときどき望ましく、たいていは想定外です。不要な場合は、受け取り側のページが読み終えたあとにディクショナリの `Clear()` を呼んでください。

`ShellNavigationQueryParameters` のオーバーロードは**単回使用**のデータを渡し、ナビゲーション完了後に Shell が自動でクリアします。

```csharp
// .NET MAUI 11, C# 14
var parameters = new ShellNavigationQueryParameters { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

`ShellNavigationQueryParameters` は `IDictionary<string, object>` を実装しているため、受け取り側のコードは同じです。既定ではこちらを使ってください。素のディクショナリに手を伸ばすのは、戻る操作で値を再配信させたいと明確に意図している場合だけにします。

1 回の呼び出しで両方を組み合わせることもできます。文字列のクエリパラメーター付き URI に、オブジェクトのディクショナリを添える形です。受け取り側の `ApplyQueryAttributes` には、両方のキーを含む 1 つのマージ済みディクショナリが渡されます。

## データを後方へ送る

後方ナビゲーションは `..` で、これにもクエリパラメーターを付けられます。メッセージバスや共有シングルトンを使わずに選択ページから結果を返す、きれいな方法です。

```csharp
// On the picker page, .NET MAUI 11
await Shell.Current.GoToAsync($"..?selectedId={selected.Id}");
```

前のページは、前方に遷移してきた場合とまったく同じように、自身が使っている仕組みで `selectedId` を受け取ります。オブジェクトも渡せます。

```csharp
var result = new ShellNavigationQueryParameters { ["Selection"] = selected };
await Shell.Current.GoToAsync("..", result);
```

`..` は組み合わせられます。`"../../route"` は 2 回ポップしてから `route` へ遷移します。これが機能するのは、ポップした結果として実際に `route` へ到達できる階層上の位置にいる場合だけです。

## コンテキスト依存のルート

グローバルルートは単独の名前ではなくパスとして登録でき、そうすると同じ相対ルートが現在位置に応じて別のページに解決されます。

```csharp
// AppShell.xaml.cs, .NET MAUI 11
Routing.RegisterRoute("orders/details", typeof(OrderDetailPage));
Routing.RegisterRoute("invoices/details", typeof(InvoiceDetailPage));
```

これで `await Shell.Current.GoToAsync("details?id=42")` は、注文セクションからは `OrderDetailPage` を、請求書セクションからは `InvoiceDetailPage` を開きます。共有の `ItemsViewModel` を遷移先ごとの分岐から解放する、うまいやり方です。

## 出荷前に知っておきたい落とし穴

**`QueryPropertyAttribute` はトリミング安全ではありません。** .NET MAUI 9 以降、ドキュメントには明示的な警告があります。この属性はプロパティの探索にリフレクションを使うため、完全トリミングや Native AOT では使うべきではありません。クエリパラメーターを受け取る型には代わりに `IQueryAttributable` を実装してください。アプリがトリミング publish や AOT publish に向かっているなら、これは 2 つの API を選ぶ決定的な要因であり、好みの問題ではありません。[トリミング安全なコードとは実際に何なのか](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)という記事で、publish 前にアナライザーに残りを指摘させる方法を扱っています。

**`//page` と `///page` は無効です。** 現在、グローバルルートがナビゲーションスタック上の唯一のページになることはできないため、グローバルルートへの絶対ルーティングは例外になります。絶対ルートはビジュアル階層専用です。

**存在しないルートへの遷移は `ArgumentException` を投げます。** 黙って何もしない挙動もフォールバックルートもないので、ルート文字列のタイプミスは空白ページではなくクラッシュになります。ルート名は `const string` フィールドを持つ `static class Routes` にまとめ、登録側と遷移側の両方でそれを使ってください。

**`Tab.Stack` は読み取り専用です。** これを変更してページを追加、削除、並べ替えすることはできません。スタックをリセットするには絶対ルート (`//orders`) へ遷移し、戻るには `..` を使います。

**プロパティのセッターは URI の順ではなく属性の順で発火します。** 複数の `[QueryProperty]` を付ける場合、別のパラメーターがすでに届いていることを前提にしたセッターを書かないでください。2 つの値をまとめて検証する必要があるなら、それはまさに `IQueryAttributable` が存在する理由です。

**遅延ナビゲーションは `GoToAsync` をブロックします。** `OnNavigating` のオーバーライド内で `args.GetDeferral()` を使っている場合、遅延が保留のあいだ `GoToAsync` は `InvalidOperationException` を投げます。なお .NET MAUI 10 と 11 でダイアログ API の名前が変わったため、遅延の標準的なサンプルは現在 `DisplayActionSheet` ではなく `DisplayActionSheetAsync` を使っています。

## .NET MAUI 11 で Shell に何が変わったか

ナビゲーションの契約そのものは .NET 11 で変わっていません。これは意図的で、このリリースは品質重視だからです。その周辺で 3 点、押さえておく価値があります。

.NET 11 Preview 6 以降、**Android の Shell アプリは既定で handler ベースの Shell アーキテクチャを使います** ([PR #34758](https://github.com/dotnet/maui/pull/34758))。従来の `ShellRenderer` の経路は、明示的に登録すれば引き続き利用できます。Android 用のカスタム Shell レンダラーがあるなら、まずここのリグレッションを確認してください。

Preview 5 以降、`BackButtonBehavior` に **`AccessibilityLabel`** プロパティが追加されました ([PR #35011](https://github.com/dotnet/maui/pull/35011))。`TextOverride` とは独立しているので、表示ラベルは短いまま、読み上げラベルだけを説明的にできます。`IconOverride` を設定するときは必ずこれも設定してください。アイコンだけではスクリーンリーダーが読み上げる有用な情報がないからです。

```xml
<!-- .NET MAUI 11 -->
<Shell.BackButtonBehavior>
    <BackButtonBehavior IconOverride="back.png"
                        AccessibilityLabel="Back to order list" />
</Shell.BackButtonBehavior>
```

そしてこれらすべての土台であるランタイムも変わりました。CoreCLR がすべての .NET MAUI プラットフォームで既定になった件は、[Preview 6 でモバイルの MAUI が CoreCLR only になった話](/ja/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/)で扱っています。ナビゲーションの意味論は変わりませんが、ナビゲートする対象のアプリのトリミングと起動の特性は変わります。そこから話は先ほどの `IQueryAttributable` 推奨へと戻ってきます。

## 関連記事

- [Xamarin.Forms 5.0 から .NET MAUI 11 への移行：完全チェックリスト](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/)。ここで扱う内容の前提となる `AppShell` の配線を説明しています。
- [高パフォーマンスな Xamarin.Forms ListView を MAUI CollectionView へ移行する](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/)。詳細ページへの遷移をたいてい起動する選択変更ハンドラーについて。
- [.NET 11 の依存性注入でキー付きサービスを登録して解決する方法](/ja/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)。2 つのルートが同じリポジトリインターフェースの別実装を必要とする場合に役立ちます。
- [Native AOT とは何か、そして何を犠牲にするのか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)。`QueryPropertyAttribute` が使えなくなる publish モードの話です。
- [.NET MAUI アプリでダークモードを正しくサポートする方法](/ja/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)。テーマ対応が中途半端なとき、最初に見た目が崩れるのが Shell のクロームだからです。

## 参照元

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation)、Microsoft Learn、.NET MAUI 11 モニカー。
- [ShellNavigationQueryParameters class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.shellnavigationqueryparameters)、.NET MAUI API リファレンス。
- [IQueryAttributable interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.iqueryattributable)、.NET MAUI API リファレンス。
- [What's new in .NET MAUI for .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11)、Microsoft Learn。
- [Android の Shell handler が既定に、dotnet/maui PR #34758](https://github.com/dotnet/maui/pull/34758)。
- [戻るボタンのアクセシビリティラベル、dotnet/maui PR #35011](https://github.com/dotnet/maui/pull/35011)。

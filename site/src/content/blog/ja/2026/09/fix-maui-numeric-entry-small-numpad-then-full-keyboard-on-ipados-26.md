---
title: "修正: iPadOS 26 で Keyboard.Numeric を指定した .NET MAUI の Entry が小さなテンキーを表示し、次にフルキーボードを表示する"
description: "iPadOS 26 では、MAUI が Keyboard.Numeric を UIKeyboardType.DecimalPad にマッピングし、これがフローティングの小さなテンキーとして開くようになりました。iPad では NumbersAndPunctuation に切り替えるマッパーを追加し、入力は自分で検証します。"
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
lang: "ja"
translationOf: "2026/09/fix-maui-numeric-entry-small-numpad-then-full-keyboard-on-ipados-26"
translatedBy: "claude"
translationDate: 2026-09-28
---

.NET MAUI 10 で `Keyboard="Numeric"` を指定した `Entry` が、iPad で最初にタップしたときは小さなフローティングのテンキーを開き、次にタップしたときは数字ページの全幅キーボードを開く (小数点やマイナス記号がない、あるいはキーが間違った数字を入力することもある) 場合、キーボードを切り替えているのは MAUI ではありません。iPadOS 26 です。MAUI は `Keyboard.Numeric` を `UIKeyboardType.DecimalPad` にマッピングしており、iPadOS 26 ではまだキーボードがドッキングされていないとき、このキーボードタイプがコンパクトなフローティングキーパッドとして表示されます。現時点で有効な修正は、`EntryHandler.Mapper` に追加して iPad 上の数値入力には代わりに `UIKeyboardType.NumbersAndPunctuation` を使わせ、そのうえでテキストを自分で検証することです。このキーボードでは文字も入力できるためです。iPhone は影響を受けず、通常の小数点付きテンキーのままです。

## エラーの状況

例外は発生しません。症状は、フォーカスイベントごとにキーボードの形が変わることです。iPadOS 26.0 または 26.1 の iPad で、素の MAUI の数値 `Entry` を使った場合:

```text
// .NET 10, Microsoft.Maui.Controls 10.0.x, iPad (10th gen), iPadOS 26.1
1st tap on Entry   -> small floating number pad (digits + decimal key), no Done bar
tap outside        -> keypad dismisses
2nd tap on Entry   -> full-width keyboard, numbers-and-symbols page
type "12.5"        -> field shows unexpected characters on some devices
switch to ABC page and back to 123 -> digits register correctly again
```

この問題を検索する人は、たいていその一部分だけを説明しています。"Keyboard.Numeric not working on iOS"、"no decimal point on iPad numeric keyboard"、"numeric keypad floating on iPad"、"MAUI Done button missing on iPad"、"numbers type random characters on iPad" などです。MAUI の追跡 issue は [dotnet/maui#32288](https://github.com/dotnet/maui/issues/32288) です (iPad 第 8 世代、iOS 26.0.1、MAUI 10.0.0-rc.2、リグレッションとしてフラグ付けされ、バックログでまだオープンのままです)。同じ挙動は Flutter でも [flutter/flutter#178096](https://github.com/flutter/flutter/issues/178096) として報告されており、ネイティブの UIKit アプリでも発生します。これが MAUI のバグではないことを示す決め手です。

## iPadOS 26 が MAUI の数値 Entry のキーボードを入れ替える理由

MAUI の iOS キーボードマッピングは短いものです。`main` ブランチの [`KeyboardExtensions.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) では、`ApplyKeyboard` が数値の場合に次の処理を行います。

```csharp
// .NET MAUI main (10.0.x and 11 previews), src/Core/src/Platform/iOS/KeyboardExtensions.cs
else if (keyboard == Keyboard.Numeric)
    textInput.SetKeyboardType(UIKeyboardType.DecimalPad);
else if (keyboard == Keyboard.Telephone)
    textInput.SetKeyboardType(UIKeyboardType.PhonePad);
```

iPadOS 26 より前は、iPad で `DecimalPad` を指定すると、単に通常のフルキーボードが数字ページで開くだけでした。iPad には専用のテンキーがなかったからです。iPadOS 26 でこれが変わりました。`decimalPad` と `numberPad` は、コンパクトなフローティングの数字専用パネルを表示するようになりました。開発者はこれによって 3 つの別々の問題に遭遇しています。

1. **フローティングパッドは、キーボードがドッキングされていないときにだけ表示されます。** ユーザーがテキストフィールドで入力していて、数値フィールドにフォーカスを移した場合、ドッキングされたキーボードは表示されたまま数字ページに切り替わります。数値フィールドが最初のファーストレスポンダーになった場合は、フローティングパッドが表示されます。Flutter の issue はまさにこれを記録しています。テキストフィールドからフォーカスが移ったときは動作し、数値フィールドに最初にフォーカスしたときはおかしな挙動になります。ユーザーが直前に何をタップしたかによってキーボードが "切り替わる" ように見えるのはこのためです。
2. **フローティングパッドは `inputAccessoryView` を隠します。** MAUI は `EntryHandler.CreatePlatformView()` で、iOS のすべての `Entry` に独自の `MauiDoneAccessoryView` を付けます。[Apple Developer Forums のスレッド 801458](https://developer.apple.com/forums/thread/801458) では、フローティングキーパッドがアクセサリーツールバーを表示しないことが報告されています。そのため Done バーも、カスタムの Next/Previous ツールバーも消えます。
3. **閉じてから再度フォーカスすると、入力がおかしいフルキーボードが表示されます。** [スレッド 808114](https://developer.apple.com/forums/thread/808114) (FB21144039) では、iPadOS 26.0 から 26.1 の Apple 純正の連絡先アプリでこれを再現しています。数値フィールドをタップすると小さなパッドが表示され、それを閉じてもう一度タップすると数字ページのフルキーボードが表示され、文字ページに切り替えて戻るまでキーが間違った文字を入力します。

これらはどれも MAUI の管理下にはなく、フローティングキーパッドをオプトアウトする UIKit API もありません。制御できるのは、テキストフィールドがどの `UIKeyboardType` を要求するかです。

## 最小の再現コード

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.x, run on an iPad with iPadOS 26.0 or 26.1 -->
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="KeyboardRepro.MainPage">
    <VerticalStackLayout Padding="24" Spacing="16">
        <Entry Placeholder="Amount" Keyboard="Numeric" />
        <Entry Placeholder="Notes" />
    </VerticalStackLayout>
</ContentPage>
```

アプリを起動し、最初に "Amount" をタップすると、フローティングのテンキーが表示されます。外側をタップしてから再び "Amount" をタップすると、フルキーボードです。次に最初に "Notes" をタップしてから "Amount" をタップすると、ドッキングされたキーボードが数字ページで表示され、フローティングパッドは出ません。同じコードで 3 種類のキーボードが表示され、どれになるかは完全にフォーカスの履歴で決まります。

## 修正 1: iPad では数値入力を NumbersAndPunctuation にマッピングする

これは Apple のフォーラムで最終的に落ち着いた回避策を、MAUI のハンドラーマッピングに置き換えたものです。`NumbersAndPunctuation` は常にドッキングされ、アクセサリービューも表示されたままで、小数点区切り文字とマイナス記号があり、多くの iOS リリースにわたって iPad で同じ挙動を保っています。

`MauiProgram.cs` に次のコードを追加します。

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x, iOS/iPadOS 26
using Microsoft.Maui.Handlers;
#if IOS
using UIKit;
#endif

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder.UseMauiApp<App>();

#if IOS
        // Runs after MAUI's own "Keyboard" mapping, so it overrides DecimalPad.
        EntryHandler.Mapper.AppendToMapping(nameof(IEntry.Keyboard), (handler, entry) =>
        {
            if (entry.Keyboard != Keyboard.Numeric)
                return;

            if (UIDevice.CurrentDevice.UserInterfaceIdiom != UIUserInterfaceIdiom.Pad)
                return;

            if (!OperatingSystem.IsIOSVersionAtLeast(26))
                return;

            handler.PlatformView.KeyboardType = UIKeyboardType.NumbersAndPunctuation;
            handler.PlatformView.ReloadInputViews();
        });
#endif

        return builder.Build();
    }
}
```

ここでは 3 つの点が重要です。

- **キー `"Keyboard"` で `AppendToMapping` を使います。** `AppendToMapping` は、そのキーの既存のマッピングの後にアクションをつなげます。そのため MAUI はまず `UpdateKeyboard` を実行し (`DecimalPad`、予測入力とスペルチェックのフラグを設定してから `ReloadInputViews` を呼び出します)、その後にあなたのアクションがキーボードタイプを上書きします。代わりに `ModifyMapping` や `PrependToMapping` を使うと、MAUI のマッピングが最後に実行されて `DecimalPad` に戻ってしまいます。後から `Entry.Keyboard` が変更されるとこのチェーンが再実行されるので、バインディングやトリガーから設定されたキーボードも修正されたままです。
- **`ReloadInputViews()` を自分で呼び出します。** フィールドがすでにフォーカスされている状態でプロパティが変わった場合、テキストフィールドに入力ビューの再読み込みを要求するまで、UIKit はキーボードを入れ替えません。
- **`#if IOS || MACCATALYST` ではなく `#if IOS` でガードします。** Mac Catalyst はハードウェアキーボードを使うため、フローティングテンキーの問題はありません。`net10.0-maccatalyst` ターゲットでは `IOS` シンボルが定義されないので、このコードは Mac 版のビルドには含まれません。

iPadOS は自身を iOS として報告するため、iPadOS でも `OperatingSystem.IsIOSVersionAtLeast(26)` は `true` を返します。このバージョンチェックにより、まだ iPadOS 18 の iPad は従来の正しい `DecimalPad` のパスを通ります。上限はあえて設けていません。Apple は挙動の変更を文書化していないので、問題が解消されるバージョンを推測するのではなく、新しい iPadOS がリリースされるたびに再テストしてからマッピングを削除してください。

## 修正 2: NumbersAndPunctuation は数字専用ではないのでテキストを検証する

`NumbersAndPunctuation` はフルキーボードの数字ページです。ユーザーは "ABC" をタップして文字を入力できますし、小数点区切り文字を複数入力することもできます。`DecimalPad` ではそうしたことは起こりえなかったので、ガードなしで `decimal.Parse(entry.Text)` を実行していたコードは `FormatException` をスローし始めます。

数値にならない入力をすべて拒否する小さな Behavior で解決できます。

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
using System.Globalization;

public sealed class DecimalInputBehavior : Behavior<Entry>
{
    protected override void OnAttachedTo(Entry entry)
    {
        entry.TextChanged += OnTextChanged;
        base.OnAttachedTo(entry);
    }

    protected override void OnDetachingFrom(Entry entry)
    {
        entry.TextChanged -= OnTextChanged;
        base.OnDetachingFrom(entry);
    }

    static void OnTextChanged(object? sender, TextChangedEventArgs e)
    {
        if (sender is not Entry entry || string.IsNullOrEmpty(e.NewTextValue))
            return;

        // Appending "0" lets partial input like "-", "12." or "," pass while typing.
        var candidate = e.NewTextValue + "0";
        var ok = decimal.TryParse(
            candidate,
            NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint,
            CultureInfo.CurrentCulture,
            out _);

        if (!ok)
            entry.Text = e.OldTextValue;
    }
}
```

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.x -->
<Entry Placeholder="Amount" Keyboard="Numeric" ReturnType="Done">
    <Entry.Behaviors>
        <local:DecimalInputBehavior />
    </Entry.Behaviors>
</Entry>
```

iOS で `UITextField.ShouldChangeCharacters` をフックするのではなく、共通レイヤーでこれを行う理由は 2 つあります。MAUI の `EntryHandler` は `MaxLength` を適用するためにすでにそのデリゲートを所有しており (iOS 26 では新しい複数範囲版を使います)、それを置き換えると `MaxLength` が黙って壊れます。また、この Behavior は Android と Windows も保護します。そこではハードウェアキーボードで数値フィールドに何でも入力できてしまうからです。

`CultureInfo.CurrentCulture` で解析することが重要です。ドイツ語設定の iPad では数字ページにカンマが表示され、`"12,5"` を解析できなければなりません。バックエンドがインバリアントな入力を期待している場合は、ユーザーの入力中ではなく、値を読み取るときに一度だけ変換してください。

## 修正 3: iPad で Done キーを復活させる

iPhone で `DecimalPad` を使う場合、iPhone の小数点付きテンキーには Return キーがないので、MAUI の `MauiDoneAccessoryView` が Done ボタンを提供します。`NumbersAndPunctuation` には Return キーがあるので、`ReturnType="Done"` を設定し (上の XAML のとおり)、`Completed` を処理します。

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
AmountEntry.Completed += (_, _) =>
{
    AmountEntry.Unfocus();
    // Commit the value, move focus to the next field, etc.
};
```

iPhone では何も変わりません。修正 1 のマッピングはそこでは実行されず、小数点付きテンキーはそのままで、アクセサリーの Done バーも引き続き機能します。

## グローバルではなく Entry ごとにオプトインする

グローバルなマッピングは、サードパーティのコントロール内のものも含め、アプリ内のすべての数値 `Entry` を変更します。一部のフィールドだけに適用したい場合は、`Entry` をサブクラス化し、マッピング内で型をチェックします。

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
public class AmountEntry : Entry
{
    public AmountEntry() => Keyboard = Keyboard.Numeric;
}

#if IOS
EntryHandler.Mapper.AppendToMapping(nameof(IEntry.Keyboard), (handler, entry) =>
{
    if (entry is AmountEntry &&
        UIDevice.CurrentDevice.UserInterfaceIdiom == UIUserInterfaceIdiom.Pad &&
        OperatingSystem.IsIOSVersionAtLeast(26))
    {
        handler.PlatformView.KeyboardType = UIKeyboardType.NumbersAndPunctuation;
        handler.PlatformView.ReloadInputViews();
    }
});
#endif
```

マッパー自体は依然としてグローバルですが (`EntryHandler` の static メンバーです)、型チェックによって影響範囲が限定されます。これは、MAUI がプロパティとして公開していないプラットフォーム調整に使うのと同じパターンです。`AppendToMapping` の実行順序については、[Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize) のハンドラーのカスタマイズに関するドキュメントで詳しく説明されています。

## 注意点と似た症状

- **`Keyboard.Telephone` は `PhonePad` にマッピングされます。** テスト用 iPad で電話番号フィールドにも同じフローティングパッドが表示される場合は、修正 1 の条件を `entry.Keyboard == Keyboard.Numeric || entry.Keyboard == Keyboard.Telephone` に拡張してください。電話番号の場合も、`UIKeyboardType.NumbersAndPunctuation` なら `+`、`(`、`)`、`-` を入力できます。
- **`CustomKeyboard` は影響を受けません。** `Keyboard.Create(KeyboardFlags...)` は `DecimalPad` を設定しないので、フローティングパッドが出ることはありませんが、iOS で数値キーボードを出すこともありません。修正手段として使わないでください。
- **iPhone での "小数点がない" は別の問題です。** iPhone では、`DecimalPad` はアプリの言語ではなく、デバイスの地域フォーマットに応じた区切り文字を表示します。カンマを使う地域に設定されたデバイスでは、米国英語のアプリでもカンマが表示されます。これは iPadOS 26 の挙動ではなく、修正 2 のカルチャーを考慮した解析がその答えです。
- **キーが間違った文字を入力する (FB21144039)。** このバグは、フローティングパッドを閉じた後のフルキーボードで発生します。修正 1 ではフローティングパッドが表示されないので、それを引き起こす閉じてから再フォーカスする流れは起こりません。それでもユーザーが遭遇した場合は、文字ページに切り替えて戻るとリセットされます。
- **その他の `Entry` ハンドラーのカスタマイズ。** すでに別の場所で `"Keyboard"` に追加している場合 (たとえばカスタムツールバーを追加するため)、`AppendToMapping` の呼び出し順がそのまま実行順になります。最後に書き込むのがどれかが明らかになるよう、キーボードの上書きはすべて 1 か所にまとめてください。

## 関連記事

- 同じハンドラーマッピングの手法は、[.NET MAUI で SearchBar のアイコンの色を変更する](/ja/2025/04/how-to-change-searchbars-icon-color-in-net-maui/)のような、ほかのネイティブな見た目の問題も解決します。
- MAUI ではなくプラットフォームが結果を決める、iOS 固有の別の予想外の挙動については、[iOS で MediaPicker.PickPhotosAsync から発生する UIKitThreadAccessException の修正](/ja/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/)を参照してください。
- キーボードの調整にまだ Xamarin.Forms のカスタムレンダラーを使っている場合は、[Xamarin.Forms から MAUI 11 への移行ガイド](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/)で、レンダラーがハンドラーマッパーにどう対応するかを説明しています。
- "OS がアプリの見た目を変えてしまった" という問題の Android 版は、[MAUI 10 の Material 3 `UseMaterial3` フラグ](/ja/2026/05/maui-10-material-3-android-usematerial3-flag/)です。
- MAUI 10 の変更点を広く知りたい場合は、[.NET MAUI 10 の新機能](/ja/2025/04/whats-new-in-net-maui-10/)から始めてください。

## 参考資料

- [dotnet/maui#32288: Keyboard Numeric is not working in iOS](https://github.com/dotnet/maui/issues/32288)
- [iOS 向けの MAUI `KeyboardExtensions.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) と [`EntryHandler.iOS.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Handlers/Entry/EntryHandler.iOS.cs)
- [Apple Developer Forums: iPad, how to prevent the new floating decimalPad](https://developer.apple.com/forums/thread/801458)
- [Apple Developer Forums: Erratic numberPad keyboard behaviour on iPadOS 26 (FB21144039)](https://developer.apple.com/forums/thread/808114)
- [flutter/flutter#178096: Weird numeric keyboard on iPadOS 26/26.1](https://github.com/flutter/flutter/issues/178096)
- [Apple Developer Documentation の `UIKeyboardType.decimalPad`](https://developer.apple.com/documentation/uikit/uikeyboardtype/decimalpad)
- [ハンドラーを使用して .NET MAUI コントロールをカスタマイズする](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize)

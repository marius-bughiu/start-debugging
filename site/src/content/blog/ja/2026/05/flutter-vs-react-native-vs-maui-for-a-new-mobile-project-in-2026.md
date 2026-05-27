---
title: "Flutter vs React Native vs .NET MAUI: 2026 年の新しいモバイルプロジェクトでどれを選ぶべきか"
description: "2026 年にグリーンフィールドのモバイルアプリを始める場合、ピクセル単位で同一の UI とアニメーション予算が重要なら Flutter 3.44 を、チームがすでに TypeScript で生活しておりリアルなブラウザ兄弟が必要なら React Native 0.82 を、iOS と Android がより広い .NET 製品の一部であり Microsoft の純正サポートが必要なら .NET MAUI 11 を選びましょう。"
pubDate: 2026-05-27
tags:
  - "comparison"
  - "flutter"
  - "react-native"
  - "maui"
  - "mobile"
  - "dotnet"
lang: "ja"
translationOf: "2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

今日始まる新しい iOS と Android のアプリにとって、正直な答えはこうです。ピクセル単位で同一の UI、ジャンクのない 120 Hz アニメーション、単一の Dart コードベースが優先事項なら Flutter 3.44 を選びましょう。エンジニアリングチームが TypeScript ファーストで、JS パッケージエコシステムをすぐに使いたく、将来のブラウザ版が視野に入っているなら React Native 0.82 を選びましょう。モバイルがより広い .NET 11 製品の 1 つのサーフェスにすぎず、サポート契約に Microsoft が乗っていることが譲れないなら .NET MAUI 11 を選びましょう。パフォーマンスはビジネスアプリの 95% で同点です。チームの適合性とエコシステムの適合性があなたの代わりに選びます。

この記事は、Flutter 3.44 (2026 年 5 月から安定版、Material 3 パッケージを分割)、React Native 0.82 (2026 年 4 月から安定版、New Architecture が必須、Bridgeless がデフォルト)、.NET MAUI 11 (執筆時点でプレビュー、GA は 2026 年 11 月予定、Android と iOS で CoreCLR がデフォルト) を対象としています。3 つとも iOS 18 と Android 15+ に配信でき、3 つとも hot reload をサポートし、3 つとも App Store と Play Store に出荷例があります。プロジェクトを実際に左右する違いは、言語、レンダリングモデル、エコシステムの成熟度、そしてバックエンドを書き直さずにチームを乗せられるプラットフォームです。

## 2026 年における各フレームワークの実態

**Flutter 3.44** は Dart ファースト、Skia でレンダリングする UI ツールキットです。すべてを自前で描画します。`Button` は `UIButton` でも `AppCompatButton` でもなく、使用した `Material` または `Cupertino` ウィジェットに基づいて Flutter エンジンが描画したピクセルそのものです。iOS ユーザーはネイティブに見える Cupertino テーマのウィジェットを、Android ユーザーは Material 3 のウィジェットを得ますが、フレームワークがあらゆるレイアウトとジェスチャを所有します。3.44 リリースで `material` と `cupertino` は別パッケージに移され、iOS 側では Swift Package Manager で配布されるようになりました。これによりモジュール単位の差分は追いやすくなりますが、`pubspec.yaml` に一度きりの移行コストが加わります。

**React Native 0.82** は、turbo-modules ブリッジ経由でネイティブの iOS と Android のビューにマッピングする JavaScript / TypeScript フレームワークです。0.78 以降は New Architecture (Fabric レンダラー + TurboModules + JSI) が新規プロジェクトのデフォルトとなり、0.82 以降はレガシーブリッジが完全に削除されました。Bridgeless モードは、可能な場合に JavaScript がネイティブコードを同期的に呼び出すことを意味し、これにより歴史的な "RN は遅く感じる" という不満は 2026 年には 2022 年ほど真実ではなくなっています。JS エンジンは両プラットフォームでデフォルト Hermes、`expo` が事実上のビルドオーケストレーターです。素の `react-native init` テンプレートはまだ存在しますが、新しいアプリの推奨経路ではなくなりました。

**.NET MAUI 11** は Microsoft の純正フレームワークです。プラットフォームネイティブのコントロールをラップします。MAUI の `Button` は、iOS では `UIButton`、Android では `AppCompatButton`、Windows では `Microsoft.UI.Xaml.Controls.Button`、Mac Catalyst では `NSButton` です。.NET 11 で Android と iOS のデフォルトランタイムが CoreCLR になり、Flutter と RN との歴史的な起動時間ギャップの大半が埋まりました。MAUI は WinUI 3 や Blazor Hybrid と同じ XAML / C# スタックを共有するので、最も理にかなうのは iOS と Android が Windows デスクトップや Blazor Web 製品の兄弟である場合であり、モバイルが宇宙のすべてである場合ではありません。

## 機能マトリクス

| 機能                                  | Flutter 3.44                        | React Native 0.82                   | .NET MAUI 11                          |
| ------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- |
| 主要言語                              | Dart 3.7                            | TypeScript / JavaScript             | C# 14                                 |
| レンダリングモデル                    | Skia、プラットフォーム間で同一のピクセル | Fabric / TurboModules 経由のネイティブビュー | プラットフォームごとのネイティブコントロール |
| iOS                                   | はい                                | はい                                | はい                                  |
| Android                               | はい                                | はい                                | はい                                  |
| Windows デスクトップ                  | はい (3.16 から安定版)              | コミュニティ (`react-native-windows`)  | はい (WinUI 3)                        |
| macOS デスクトップ                    | はい (3.16 から安定版)              | コミュニティ (`react-native-macos`) | Mac Catalyst                          |
| Linux デスクトップ                    | はい (3.10 から安定版)              | いいえ                              | いいえ                                |
| Web (ブラウザ)                        | プレビュー、大規模アプリ向けはプロダクション非対応 | はい (React DOM 経由、コード共有は限定的) | いいえ (Blazor Hybrid は別建て)   |
| Hot reload                            | サブ秒、ステートフル                | Fast Refresh、ステートフル          | はい (.NET 11)                        |
| Android のデフォルトランタイム (.NET 11) | AOT コンパイル済み Dart           | Hermes JS                           | CoreCLR                               |
| デフォルト IDE                        | VS Code、Android Studio             | VS Code、WebStorm                   | Visual Studio 2026、Rider             |
| パッケージエコシステム                | pub.dev、5 万以上のパッケージ       | npm、JS の全世界                    | NuGet、.NET エコシステム              |
| 純正サポート                          | Google                              | Meta + コミュニティ                 | Microsoft                             |
| New Architecture / ランタイムベースライン | 常時 AOT                        | 0.80 以降必須                       | .NET 11 Preview 4 以降 CoreCLR がデフォルト |
| ライセンス                            | BSD-3                               | MIT                                 | MIT                                   |
| 状態管理のデフォルト                  | Riverpod、Bloc、Provider            | Redux Toolkit、Zustand、TanStack Query | CommunityToolkit.Mvvm              |

ほとんどのプロジェクトを決めるのは 3 つの行、主要言語、レンダリングモデル、純正サポートです。残りは細部の調整です。エンジニアリングチームが TypeScript を書き、バックエンドが Node なら、React Native への移行は数か月ではなく数日です。チームが .NET と Entity Framework Core に対して C# を書いているなら、MAUI は DTO、検証、さらには ViewModel を Web 層と共有できるようにします。Flutter は、生産的な言語が事実上フレームワーク固有である唯一の選択肢であり、チームが Dart を書いたことがなければ本物の税金になります。

## Flutter 3.44 を選ぶとき

次の場合に Flutter を選びましょう。

- **iOS と Android にまたがるピクセル単位で同一の UI が製品の一部である場合。** カスタムデザインシステム、ブランド主導のアプリ、ゲーム隣接アプリ、デザインチームが強い意見を持つコンシューマー製品。Flutter は上から下まで Skia でレンダリングするので、`CustomPainter` はプラットフォームごとの調整なしに Pixel 8 と iPhone 15 で同じに見えます。これが 2026 年にチームが Flutter を選ぶ最も一般的な単一の理由です。
- **アニメーション予算が重要で、スペックに 120 Hz が入っている場合。** Flutter のレンダーパイプラインは 120 Hz をターゲットに構築されています。Impeller (新しいグラフィックスバックエンド、iOS では 3.7 以降、Android では 3.16 以降がデフォルト) は、初期 Flutter アプリを苦しめたシェーダーコンパイルのジャンクを排除します。重いジェスチャ駆動の UI、複雑なアニメーションリスト、ゲームに近いものを構築するなら、Flutter は 3 つの中で最も安全な賭けです。
- **iOS、Android、デスクトップに 1 つのコードベースで妥協なく届けたい場合。** Flutter Desktop は Windows、macOS、Linux で GA です。ウィジェットカタログは同じで、入力モデルとウィンドウクロームだけが変わります。他の 2 つは比較可能な Linux デスクトップストーリーを出荷していません。
- **チームが Dart の学習を吸収できる場合。** 2026 年の Dart 3.7 は、健全な null 安全性、パターンマッチング、レコード、クラス修飾子キーワード (`sealed`、`final`、`interface`) を備えた強力な言語です。TypeScript や C# のシニアエンジニアは約 2 週間で生産性に達します。Flutter 外のエコシステムが小さいため、ジュニアエンジニアはより時間がかかります。

最小構成の Flutter 3.44 `main.dart`:

```dart
// Flutter 3.44, Dart 3.7
import 'package:flutter/material.dart';

void main() => runApp(const HelloApp());

class HelloApp extends StatelessWidget {
  const HelloApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hello Flutter',
      theme: ThemeData(useMaterial3: true),
      home: const HelloPage(),
    );
  }
}

class HelloPage extends StatelessWidget {
  const HelloPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Hello')),
        body: const Center(child: Text('Hello, Flutter')),
      );
}
```

`useMaterial3: true` フラグは 3.44 でデフォルトになっており (内部で何が変わったかは [Flutter 3.44 の Material と Cupertino パッケージ分割](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) を参照)、新規プロジェクトではこの行を省略できます。

## React Native 0.82 を選ぶとき

次の場合に React Native を選びましょう。

- **チームがすでに Web 向けに React と TypeScript を書いている場合。** これが 2026 年に RN がベイクオフで勝つ単一の最大の理由です。Hooks、コンポーネントモデル、データフェッチライブラリ (TanStack Query、SWR)、ほとんどの検証ライブラリ (Zod) はそのまま動作します。シニアの React エンジニアは数週間ではなく数日で動作する RN 機能を出荷します。Flutter と MAUI はどちらも新しいコンポーネントモデルの学習を要求します。
- **特に AI、決済、分析まわりで npm パッケージを再利用する必要がある場合。** JavaScript エコシステムは Dart の `pub.dev` や .NET のモバイル特化 NuGet パッケージを圧倒します。ロードマップに Stripe、Segment、Anthropic SDK、OpenAI SDK、LangChain、あるいは AI ツーリング層の何かが含まれているなら、Dart や C# の同等物より先に純正の JS / TS ライブラリが見つかります。
- **同じ製品に Web 版が必要で、Web とモバイル間のコード共有が計画の一部である場合。** React Native と React DOM は別のレンダリングターゲットですが、hooks、ビジネスロジック、検証を共有し、[React Native for Web](https://github.com/necolas/react-native-web) や Expo の universal apps を使えば表示用コードのおよそ 60〜70% を共有できます。Flutter には Web ターゲットがありますが、2026 年時点で大規模アプリに対してはプレビュー品質であり、MAUI には本物のブラウザストーリーがありません (Blazor Hybrid は別スタックです)。
- **Hermes + New Architecture をレガシーブリッジの頭痛なしに使いたい場合。** 0.82 時点でレガシーブリッジは消えました。モジュールは JSI で TurboModules を使い、レンダラーは Fabric であり、移行されていない古いパッケージはロードされません。これは RN がローンチ以来持ってきたどのベースラインよりもクリーンであり、2022 年時代のスレッドホッピングのレイテンシに関する不満はほとんど当てはまらなくなりました。

最小構成の React Native 0.82 `App.tsx`:

```typescript
// React Native 0.82, Expo SDK 53, TypeScript 5.6
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>Hello, React Native</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
```

Expo がデフォルトのスキャフォールドになりました。新規プロジェクトは `npx create-expo-app`、カスタムネイティブモジュールが必要なら `expo prebuild`、クラウドビルドの `.ipa` と `.aab` 成果物には EAS Build を使います。"bare workflow" はまだ存在しますが、チームは Expo SDK 51 以降、新規アプリには推奨していません。

## .NET MAUI 11 を選ぶとき

次の場合に MAUI を選びましょう。

- **iOS と Android がより広い .NET 製品のコンパニオンサーフェスである場合。** Blazor Server の管理コンソールも持つフィールドサービスツール、Windows のバックオフィスと Entity Framework Core ドメインを共有する小売 POS、検証ルールが ASP.NET Core API とデバイスの両方で走るヘルスケアアプリ。MAUI は、データモデル、DTO、FluentValidation ルール、さらには `CommunityToolkit.Mvvm` を使った ViewModel まで共有できます。1 つの言語でその範囲をカバーできる他のフレームワークはありません。
- **Xamarin.Forms から移行する場合。** これが公式の経路です。[Xamarin.Forms ListView から MAUI CollectionView への移行ガイド](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) は最も質問の多い単一の移行ステップであり、ツールチェーンは苦痛の多かった 8.0 時代から成熟しました。
- **Microsoft の純正サポートと、契約上の単一ベンダーが必要な場合。** Microsoft Premier または Unified サポート契約を持つエンタープライズ調達チームは、MAUI のサポートが含まれます。Flutter には Google があるもののエンタープライズ契約がなく、React Native には Meta とベンダーのコミュニティがあります。
- **チームが C# を書き、バックエンドが .NET の場合。** モバイル、Web、デスクトップ、サーバーで単一の言語を共有することは、本物の生産性の乗数です。型チェックされたワイヤー越しの DTO (System.Text.Json ソースジェネレーター)、共有された検証、同一のロギングプリミティブ。Flutter と RN はコード生成ステップや重複実装なしにこれを実現できません。

最小構成の MAUI 11 `MauiProgram.cs`:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

[.NET 11 Preview 4 における CoreCLR デフォルト化の切り替え](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) は、Android と iOS で歴史的な MAUI のコールドスタートギャップの大半を埋めるもので、これは 8.0 GA 以来フレームワークに対する単一の最大の更新です。

## ベンチマーク: コールドスタートとバンドルサイズ

以下の数値は、フレームワークごとの "Hello World" テンプレートをリリースビルドし、Pixel 8 (Android 15) と iPhone 15 (iOS 18.4) にインストールしたものです。コールドスタートは `am start` (Android) と Instruments の Launch トレース (iOS) から測定し、プロファイル事前最適化なし、MAUI で Native AOT なし、Flutter で Impeller オン、RN で Hermes + Fabric です。

| 指標                                      | Flutter 3.44     | React Native 0.82 | MAUI 11 (CoreCLR) |
| ----------------------------------------- | ---------------- | ----------------- | ----------------- |
| Android コールドスタート、アプリコードのみ | 320 ms           | 450 ms            | 480 ms            |
| Android APK サイズ、release、単一アーキ   | 19 MB            | 24 MB             | 22 MB             |
| iOS コールドスタート、アプリコードのみ    | 280 ms           | 340 ms            | 360 ms            |
| iOS IPA サイズ、release                   | 28 MB            | 35 MB             | 38 MB             |
| アイドル時メモリフットプリント (Android)  | 78 MB            | 110 MB            | 132 MB            |
| 重いスクロール下での FPS                  | 119.2            | 117.8             | 118.4             |

Flutter はエンジンが起動時から AOT コンパイル済み Dart であり、JS や CoreCLR ランタイムを先に立ち上げないため、全方位でコールドスタートに勝利します。React Native は Hermes + Fabric が初期化コストをフレームごとではなく一度だけ支払うため、以前より MAUI に近づきました。CoreCLR 上の MAUI は、引用されている可能性のある MAUI-on-Mono 値 (同じテンプレートで Android で ~720 ms) よりも RN に近づいています。FPS の行は本質的に同点です。アプリが立ち上がってしまえば 3 つともデバイスのリフレッシュ天井でレンダリングします。コールドスタートはアプリ起動時の体感に効きます。持続 FPS はアプリ内の触感に効きます。最初の行は "アイコンがキビキビ感じるか" を決定します。最後の行は "アプリがモダンに感じるか" を決定します。最初の行のギャップは本物ですが小さく、最後の行のギャップは測定できません。

## あなたの代わりに決めてしまう落とし穴

好みに関係なく決定を強制するものが 3 つあります。

1. **チームの既存言語。** TypeScript チームは React Native を選びます。C# チームは MAUI を選びます。既存スタックを持たないチーム、あるいは Dart を学ぶ意思のあるチームだけが Flutter を選びます。シニアエンジニアにモバイルプロジェクトでしか使わない 3 つ目の言語を教えるコストは本物であり、機能マトリクスの表には現れません。
2. **Web が v1 になくともロードマップに入っている場合。** "いずれ Web 版を出荷する" が製品スペックに入っているなら、`react-native-web` を使った RN または Flutter Web が 2 つの実行可能な経路ですが、2026 年にプロダクションレディなのは RN だけです。Flutter Web は非自明なアプリにとってプレビュー品質のターゲットであり、Flutter チームもそう述べています。MAUI にはブラウザストーリーがありません (Blazor Hybrid はプログラミングモデルが異なる別スタックです)。MAUI を選んで後で Web 版が必要になった場合、2 つ目のアプリを書くことになります。
3. **抽象化できない純正ネイティブモジュール。** App Tracking Transparency ダイアログ、App Clips、Live Activities、Dynamic Island ウィジェット、Wear OS タイル、Health Connect、App Intents。Flutter にはこれらのほとんどにプラグインがあり、一部はまだコミュニティメンテナンスです。RN は Expo エコシステムのおかげで最も広いプラグインカバレッジを持ちます。MAUI は下層のコントロールが実際のプラットフォームのウィジェットであるため、ネイティブのプラットフォーム API を直接公開し、機能ごとのプラグインギャップは少ないです。製品スペックの最初の四半期に iOS プラットフォーム機能が 3 つ以上並ぶなら MAUI が最も摩擦が低く、Android プラットフォーム機能が 3 つ以上並ぶなら、プラグインエコシステムがより広いので Flutter か RN の方が楽です。

エコシステムがどう分岐するかの実用的な例として、AI 統合があります。TypeScript と Python 向けの Anthropic SDK は純正です。[Dart 向けの Anthropic SDK](https://pub.dev/) はコミュニティメンテナンスです。.NET 向けの Anthropic SDK はコミュニティメンテナンスですが、[.NET 11 の Microsoft.Extensions.AI](/ja/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) でカバーされており、これはプロバイダークライアントではないにせよ抽象化層では純正です。モバイルアプリが直接 AI 呼び出しを行うなら、2026 年において RN が顕著な差で最も摩擦の少ない経路です。

## 再確認した推奨

今日始まる新しいモバイルアプリの場合:

- **ピクセル単位で同一の UI、120 Hz アニメーション、デザインチーム主導の製品、Dart に投資する意思**: **Flutter 3.44** を選びましょう。最速のコールドスタート、Impeller 駆動のレンダーパイプライン、視野に入る GA Linux デスクトップ。
- **TypeScript チーム、npm 重視のロードマップ、ロードマップに Web 兄弟がある場合**: **React Native 0.82** を選びましょう。New Architecture は必須かつクリーンで、Expo がデフォルトのスキャフォールドであり、JavaScript エコシステムは 3 つの中で最も深いです。
- **モバイルがより広い .NET 11 製品の 1 つのサーフェスで、サポート契約に Microsoft が乗る場合**: **.NET MAUI 11** を選びましょう。モバイル、デスクトップ、サーバーにわたる共有 C# スタック。CoreCLR デフォルト化が歴史的なコールドスタートギャップの大半を埋めます。

既存アプリからの移行を検討している場合:

- Xamarin.Forms から: MAUI に進みましょう。移行経路は直接的です。
- React の Web コードベースから: Expo を使った RN が最も少ない労力です。
- WebView がボトルネックである不幸なハイブリッドスタック (Cordova、Ionic、Capacitor) から: Flutter と RN のどちらでも問題は解決します。言語の適合性で選びましょう。

## 関連

- [MAUI vs Avalonia vs Uno Platform: 2026 年にどれを選ぶべきか](/ja/2026/05/maui-vs-avalonia-vs-uno-in-2026/) .NET 内部のクロスプラットフォーム比較について。
- [Flutter 3.44 の Material と Cupertino パッケージ分割、Swift Package Manager がデフォルトに](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) 最新の Flutter リリースについて。
- [.NET 11 Preview 4 における Android と iOS のデフォルト CoreCLR への移行](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) この記事における MAUI のコールドスタート値を更新したランタイム変更について。
- [MAUI アプリを Microsoft Store 用にパッケージする方法](/ja/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) MAUI がデスクトップの兄弟である場合の Windows 配布側について。
- [Xamarin.Forms ListView を MAUI CollectionView に移行する方法](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) Xamarin から MAUI への移行で最も質問の多い単一の移行ステップについて。

## 参考資料

- [Flutter 3.44 リリースノート](https://docs.flutter.dev/release/release-notes)、Flutter ドキュメント、2026-05-27 アクセス。
- [React Native 0.82 リリースノート](https://reactnative.dev/blog)、Meta オープンソース。
- [.NET MAUI ドキュメント](https://learn.microsoft.com/dotnet/maui/)、Microsoft Learn、2026-05-27 アクセス。
- [Expo SDK 53 チェンジログ](https://docs.expo.dev/)、Expo ドキュメント。
- [React Native New Architecture 概要](https://reactnative.dev/docs/the-new-architecture/landing-page)、React Native ドキュメント。
- [Impeller グラフィックスバックエンド](https://docs.flutter.dev/perf/impeller)、Flutter ドキュメント。

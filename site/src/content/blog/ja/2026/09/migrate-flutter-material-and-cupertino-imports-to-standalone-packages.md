---
title: "Flutter の Material / Cupertino インポートを material_ui と cupertino_ui パッケージへ移行する"
description: "package:flutter/material.dart と package:flutter/cupertino.dart から material_ui 1.1.1 / cupertino_ui 1.0.2 への完全な移行手順です。dart fix --code=migrate_design_widgets が何を書き換えるのか、なぜサードパーティ製ウィジェットが祖先の探索に失敗し始めるのか、MaterialUiCompatibilityBridge が実際に何を解決するのか、そして flutter_localizations への依存がどう変わるのかを解説します。"
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material-design"
  - "cupertino"
lang: "ja"
translationOf: "2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages"
translatedBy: "claude"
translationDate: 2026-09-03
---

Material を使っているのが自分のコードだけというアプリなら、この移行はコマンド 1 つ、半日で終わります。`flutter pub add material_ui` を実行し、次に `dart fix --apply --code=migrate_design_widgets` を実行し、テストを走らせるだけです。ウィジェットの API は SDK に入っていたものと同一のコピーなので、描画は何も変わらず、golden も動かないはずです。実際に時間を食うのは依存関係グラフです。まだ `package:flutter/material.dart` をインポートしているパッケージは、`Theme`、`Material`、`MaterialLocalizations` の 2 つ目の、型として互換性のないコピーをプログラムに持ち込みます。そうしたパッケージのウィジェットは、アプリを `MaterialUiCompatibilityBridge` でラップするまで、移行済みのツリーの中で祖先の探索に失敗します。本記事は現行の stable チャネル、Flutter 3.47.2 と Dart 3.13.2、そして [`material_ui`](https://pub.dev/packages/material_ui) 1.1.1 と [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.0.2 を対象としています。

ここでは期限が重要です。SDK 内のライブラリはすでに凍結されており、正式な非推奨化は 2026 年 11 月の stable リリースに予定されています。

## これが任意の片付けではない理由

- **SDK 内のコピーには修正が入りません。** Flutter は 2026-04-07 に `flutter/flutter` の Material と Cupertino ディレクトリへのすべての貢献を締め切りました。それ以降のバグ修正はすべて `flutter/packages` 側に入っています。`material_ui` 1.1.1 には、SDK 内のコピーが決して受け取れない修正がすでに含まれています。古い非同期サジェストの結果が新しい結果を上書きしてしまう `SearchAnchor` の競合状態や、`Slider` の値インジケーターのラベルが画面端で省略記号にならず切り取られていた問題などです。
- **デザインの更新が SDK の列車を待たなくなります。** Material と Cupertino は Flutter 自身の四半期サイクルでリリースされていたため、トークンの微調整や `MenuAnchor` の新しい引数は次の stable まで待たされていました。`material_ui: ^1.1.1` に固定すればこれが切り離されます。1.1.0 と 1.1.1 はどちらも stable 3.47 と本日の間にリリースされています。
- **使っていないデザインシステムをついに切り離せます。** SDK 内のコピーが削除されれば、Cupertino だけのアプリは Material のテーマ、タイポグラフィ、アイコンのメタデータを tree-shaking 越しに引きずらなくなります。逆も同様です。
- **ローカライズはウィジェットと一緒に移動します。** Material と Cupertino の翻訳文字列とデリゲートはパッケージ側に入りました。だからこそ `flutter_localizations` を自分で書く必要がなくなります。
- **パッケージを公開している側は、そのままだとブロッカーになります。** 移行していないリーフパッケージが 1 つあるだけで、その下流のすべてに互換ブリッジを強制します。

## 壊れるもの

| 領域 | 変更 | 深刻度 |
| ---- | ---- | ------ |
| インポート | `package:flutter/material.dart` は `package:material_ui/material_ui.dart` になり、`package:flutter/cupertino.dart` は `package:cupertino_ui/cupertino_ui.dart` になります | 高、ただし完全に自動化可能 |
| 型の同一性 | SDK の `Material` と `material_ui` の `Material` はランタイムでは別の型なので、祖先の探索は境界を越えられません | 高、ブリッジが必要 |
| ローカライズのデリゲート | `GlobalMaterialLocalizations` と `GlobalCupertinoLocalizations` は `flutter_localizations` ではなくパッケージから提供されます | 中 |
| `pubspec.yaml` | 直接依存が 2 つ増え、`flutter_localizations` は自分で書く必要のある直接依存ではなくなります | 中 |
| 生成コード | `.g.dart` や `.freezed.dart` に `package:flutter/material.dart` を出力するものは、ソースの一括変換後に再生成が必要です | 中 |
| 公開パッケージ | 自分のパッケージを移行することは利用側にとって破壊的変更なので、メジャーバージョンを上げる必要があります | 中 |
| ウィジェットの API | 変更なし。コンストラクター、パラメーター、描画はそのままです | なし |

この最後の行が、この移行が現実的である理由そのものです。`material_ui` 1.0.0 は 2026 年 4 月の凍結時点における同梱ライブラリのコピーであり、再設計ではありません。

## 事前チェックリスト

- Flutter 3.44 以降。`material_ui` はコードが `flutter/flutter` から出た時点で下限を Flutter 3.44 / Dart 3.12 に上げており、現行の stable は 3.47.2 です。`flutter --version` で確認します。
- 開始前にクリーンな `flutter analyze`。移行後の実行結果と比較できる状態にしておきます。
- ブランチを切ること。`dart fix --apply` は該当するファイルを一度に書き換え、取り消すフラグはありません。
- Material または Cupertino のウィジェットを描画する依存関係の棚卸し。`flutter pub deps --style=compact` と `flutter pub outdated` で一覧が得られます。2026 年 8 月より前が最終公開のものは移行していません。
- golden テストがあるなら先に実行してベースラインをコミットします。変わらないはずであり、それがここで検証したい主張です。

## 移行手順

1. **インポートに手を付ける前にパッケージを追加します。** `dart fix` のルールが書き換えるのはインポート文字列だけで、`pubspec.yaml` は編集しません。順序を逆にすると、解決できないインポートで埋まったファイルができます。

   ```sh
   # Flutter 3.47.2, Dart 3.13.2
   flutter pub add material_ui
   flutter pub add cupertino_ui
   ```

   本日時点では `material_ui: ^1.1.1` と `cupertino_ui: ^1.0.2` に解決されます。Material だけのアプリでも `cupertino_ui` は推移的に入ります。`material_ui` は 1.0.1 リリース以降 `cupertino_ui: ^1.0.0` に依存しているためです。ただし直接インポートするなら明示的に宣言してください。`flutter pub deps --style=compact | grep -E 'material_ui|cupertino_ui'` で両方が解決されていることを確認します。

2. **同梱の fix でインポートを書き換えます。** 両パッケージは同じアナライザーの fix を登録しているので、1 つのコマンドで Material と Cupertino をまとめて処理できます。

   ```sh
   dart fix --dry-run --code=migrate_design_widgets   # review first
   dart fix --apply  --code=migrate_design_widgets
   ```

   結果はファイルごとに 1 行の差分です。

   ```dart
   // Before: Flutter 3.43 and earlier
   import 'package:flutter/material.dart';

   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';
   ```

   インポート行より下は何も変わりません。`MaterialApp`、`Scaffold`、`ThemeData`、`Colors`、`showDialog` など、あらゆる名前が同じ識別子でエクスポートされます。`grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" lib test` が何も返さないことを確認し、続けて `flutter analyze` を実行します。

3. **ローカライズのデリゲートをパッケージ側に向けます。** デリゲートと翻訳文字列は `material_ui` と `cupertino_ui` に移動しており、3 つのデリゲートを手で並べる手間を省く集約用のゲッターが提供されています。

   ```dart
   // Before: flutter_localizations, Flutter 3.43
   import 'package:flutter_localizations/flutter_localizations.dart';

   localizationsDelegates: const <LocalizationsDelegate<Object>>[
     GlobalMaterialLocalizations.delegate,
     GlobalCupertinoLocalizations.delegate,
     GlobalWidgetsLocalizations.delegate,
   ],
   ```

   ```dart
   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';

   localizationsDelegates: GlobalMaterialLocalizations.delegates,
   ```

   `GlobalMaterialLocalizations.delegates` には Cupertino と Widgets のデリゲートがすでに含まれています。`gen-l10n` も併用している場合、生成された `AppLocalizations.delegate` は影響を受けず、従来どおりこのリストに追加します。`flutter_localizations` は自分の `dependencies` から外せますが、`pubspec.lock` には残ります。`cupertino_ui` 1.0.2 は `collection: ^1.19.1` と `intl: ^0.20.2` とともに依然としてこれに依存しています。英語以外のロケールで起動し、組み込み文字列を確認して検証します。たとえば `TextField` を長押しして、貼り付けの表示が翻訳されていることを確かめます。

4. **移行していない依存関係をブリッジします。** 誰もが飛ばしては 1 時間デバッグする手順です。アプリ全体を `MaterialApp.builder` でラップします。

   ```dart
   // material_ui 1.1.1
   MaterialApp(
     theme: ThemeData(useMaterial3: true),
     builder: (BuildContext context, Widget? child) {
       return MaterialUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   Cupertino 側も対称です。

   ```dart
   // cupertino_ui 1.0.2
   CupertinoApp(
     builder: (BuildContext context, Widget? child) {
       return CupertinoUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   旧来のウィジェットを埋め込んでいる画面が 1 つだけなら、より狭いサブツリーをラップすることもできます。そうすれば追加の inherited widget をツリーの残りに持ち込みません。サードパーティ製ウィジェットを載せている画面をすべて開いて検証します。ブリッジは一時的な足場です。`flutter pub outdated` で旧インポートを使うものがなくなったら削除してください。

5. **コードジェネレーターが書いたものを再生成します。** `dart fix` が見るのはソースであり、それを生成したテンプレートではありません。手順 2 のあとでジェネレーターを再実行し、出力ファイルが SDK 内のライブラリをインポートしないようにします。

   ```sh
   dart run build_runner build --delete-conflicting-outputs
   ```

   そのうえで `dart fix` が届かない残りを確認します。利用側に Material を再エクスポートする `export` の barrel ファイル、プラットフォームごとに Material の実装を選ぶ条件付きインポート、そしてインポートパスを文字列として直書きしている自作のジェネレーターテンプレートです。手順 2 と同じ `grep` を、`lib` と `test` だけでなくリポジトリ全体に広げて検証します。

6. **パッケージを公開しているなら、メジャーバージョンを上げます。** 公開パッケージを `material_ui` に切り替えると、利用側の `pubspec.yaml` に必要なものが変わります。これをマイナーリリースとして出すとアプリが静かに壊れます。利用側のウィジェットツリーが 2 つの出自を混在させ、それを指し示すコンパイルエラーが出ないからです。次のメジャーバージョンに上げ、必要な `material_ui` の制約を changelog に明記し、古い Flutter バージョンをサポートしているなら以前のメジャーバージョンをメンテナンスブランチに残します。`dart pub publish --dry-run` で検証します。

## 検証

- `flutter analyze` の件数が移行前のベースラインと同じで、`uri_does_not_exist` がなく、インポート行に `deprecated_member_use` も出ていないこと。
- `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" .` が `.dart_tool` と `pubspec.lock` の外で何も見つけないこと。
- `flutter test` が通り、golden テストも含めて変化がないこと。golden が動いたなら、それは Material が変わったのではなく、同じツリーでライブラリの 2 つのコピーが描画しているという意味です。
- 実機でアプリが動き、サードパーティ製ウィジェットを埋め込んだすべての画面が既定値ではなく自分のテーマで描画されること。
- 手順 3 のあとも、英語以外のロケールで組み込み文字列が翻訳されて表示されること。
- 後で比較するためのサイズのベースラインとして `flutter build apk --release --analyze-size` (iOS なら相当するコマンド) を取っておくこと。SDK 内のコピーが削除され、tree-shaking が使っていないデザインシステムを実際に落とせるようになったときに効きます。

## ロールバック

現時点では完全に戻せます。変更点は `pubspec.yaml` の差分、ファイルごとに 1 行のインポート、デリゲートのリスト、そして任意のブリッジウィジェットだけなので、移行コミットを `git revert` すれば、巻き戻すべきデータやビルド成果物なしで SDK のライブラリに戻れます。注意点は 2 つです。逆向きの `dart fix` は存在しないため、手作業のロールバックはすべてのインポートを手で戻すことになります。だからこそ手順ゼロがブランチなのです。そしてもう 1 つ、2026 年 11 月の stable 以降に revert すると、削除予定の正式に非推奨な API に居座ることになります。ロールバックはリリースを通すための手段であって、意思決定ではないと考えてください。

## つまずきやすい点

**自分が書いていないコードから出る "Could not find an ancestor of type MaterialLocalizations"。** これは型の同一性の問題がランタイムに現れたものです。SDK のライブラリに対してコンパイルされたウィジェットが `MaterialLocalizations.of(context)` を呼ぶと、*そのウィジェット側の* `MaterialLocalizations` 型の inherited widget を探してツリーを遡ります。`material_ui` の `MaterialApp` が挿入したのは同名の別の型なので探索は外れ、assert が発火します。`Theme.of(context)` も同じように失敗し、"Could not find an ancestor of type Theme" になります。手順 4 のブリッジは、旧来の inherited widget を新しいものと並べて挿入し、双方の探索が解決するようにするために存在します。これは `Scaffold` を忘れた場合の回避策ではありません。エラーが自分の移行済みコードから出ているなら、それは [no Material widget found in Flutter](/ja/2026/08/fix-no-material-widget-found-in-flutter/) で説明したごく普通の問題で、ブリッジでは解決しません。

**fix を実行した直後にインポートが解決できない。** `flutter pub add` より先に `dart fix` を実行した状態です。パッケージを追加してから `dart fix --apply --code=migrate_design_widgets` を再実行してください。このルールは冪等です。

**1 つのファイルに両方のインポートを残さないこと。** `package:flutter/material.dart` と `package:material_ui/material_ui.dart` は同じ識別子をエクスポートするため、両方を含むファイルは `Material`、`Theme`、`Colors` などであいまいなインポートのエラーになります。片方に接頭辞を付ければコンパイルは通りますが、1 つのファイルにデザインシステムが 2 つ入る状態になり、エラーより悪いです。ファイルごとにどちらか一方を選んでください。

**凍結の日付と非推奨化の日付は別物です。** [コード凍結の告知](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze)では、SDK のライブラリは 3.44 の*次の* stable リリースで非推奨になるとされていました。これはずれ込みました。3.47 は 2026-08-12 に非推奨化なしでリリースされ、[3.47 のリリースノート](https://flutter.dev/blog/whats-new-in-flutter-3-47)は正式な非推奨化を 11 月の stable に置いています。4 月に凍結、11 月に非推奨、削除はさらにあとです。今日アナライザーが黙っていることではなく、11 月を基準に計画してください。

**ウィジェットが変わらなくてもアセットのマニフェストは動きえます。** `material_ui` 1.1.0 は `ink_sparkle` シェーダーのアセットを自身の `pubspec.yaml` から公開し、`stretch_effect` シェーダーを削除しました。アセットのマニフェストを検証している場合や、ビルド手順で未使用アセットを削っている場合は、これは実際に確認すべき差分です。

**インポートの移行と Flutter のバージョン更新は別のコミットにしてください。** 同じ作業で SDK のバージョンを飛ばすと、視覚的なリグレッションの原因候補が 2 つになります。まず SDK のアップグレードを入れ、アプリがクリーンだと確認してから、インポートを移行します。

## 関連記事

- この移行の前提となった告知は、同じリリースで入った SwiftPM の既定化も含めて [Flutter 3.44 が Material と Cupertino を SDK から切り出す](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) にまとめてあります。
- 構造としては [Flutter web アプリを dart:html から package:web へ移行する](/ja/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/) と同じ、広く機械的な一括作業です。`dart fix` が簡単な 95 % を処理し、依存関係グラフがあなたを処理するところまで同じです。
- `dart fix` が明確に自動化できない非推奨化の例としては、[Radio.groupValue と onChanged を RadioGroup に置き換える](/ja/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/) と比べてみてください。
- 同じサイクルで現行の stable にも上げるなら、視覚的なリグレッションをパッケージの入れ替えのせいにする前に [Flutter 3.47 がデスクトップの描画で変えたこと](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) を読んでおいてください。
- 祖先の探索の失敗は単発ではなく一族です。[ScaffoldMessenger.of(context) does not contain a Scaffold](/ja/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) は、同じデバッグ手法を別の inherited widget に当てたものです。

## 参考資料

- [pub.dev の material_ui](https://pub.dev/packages/material_ui) バージョン 1.1.1 と、その [changelog](https://pub.dev/packages/material_ui/changelog)
- [pub.dev の cupertino_ui](https://pub.dev/packages/cupertino_ui) バージョン 1.0.2
- [Flutter's Material and Cupertino code freeze](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze), Flutter ブログ
- [What's new in Flutter 3.44](https://flutter.dev/blog/whats-new-in-flutter-3-44), Flutter ブログ
- [What's new in Flutter 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47), Flutter ブログ
- [デザインシステム分離のトラッキング issue](https://github.com/flutter/flutter/issues/172932), flutter/flutter
- [Flutter 3.47.0 リリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0), docs.flutter.dev

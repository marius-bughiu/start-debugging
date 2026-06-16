---
title: "Flutter 2 アプリを Flutter 3.x に移行する: null safety チェックリスト"
description: "レガシーな Flutter 2.x アプリを現行の Flutter 3.x リリースへ移すための、バージョンを固定した手引きです。sound null safety への移行が厳格なゲートになります。なぜ Dart 2.19 を経由する 2 段階の経路が必要か、dart migrate が何をするか、そして途中で何が壊れるかを解説します。"
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "flutter"
  - "flutter-2"
  - "flutter-3"
  - "dart"
  - "null-safety"
lang: "ja"
translationOf: "2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist"
translatedBy: "claude"
translationDate: 2026-06-16
---

sound null safety をオプトアウトした Flutter 2.x アプリがまだ残っているなら、現行の Flutter 3.x リリースへ直接ジャンプすることはできません。Flutter 3.10（2023 年 5 月）で登場した Dart 3 は、安全でない（unsound）null safety を完全に削除し、`dart migrate` ツールを取り除きました。そのためアップグレードは 2 段階の移行になります。まず Dart 2.19（Flutter 3.7.x）でコードベースを null-safe にし、次に最新の Flutter 3.x へ引き上げます。小さなアプリで 1 日、推移的依存関係が多い大きなアプリで 3 ～ 5 日を見込んでください。null safety のパスがゲートであり、それ以外（Gradle、iOS の最低バージョン、削除されたウィジェット）はアナライザーが緑になればすべて機械的です。この手引きは出発点として Flutter 2.10 / Dart 2.16 を、目標として Dart 3 を実行する現行の Flutter 3.x ラインを固定します。

## なぜこれが 1 段階ではなく 2 段階の旅なのか

最初の発想は、最新の Flutter をダウンロードし、`flutter pub get` を実行し、壊れた箇所を直す、というものです。unsound な Flutter 2 アプリではこれは即座に失敗します。必要なツールが、アップグレード先の SDK にはもう存在しないからです。

sound null safety は Dart 2.12（Flutter 2.0、2021 年 3 月）でオプションとして登場しました。2 年間、混在モードによって null-safe なライブラリとレガシーなライブラリが共存できました。Dart 3 はこれを終わらせました。公式の手引きより: "In Dart 3, null safety is built in; you cannot turn it off." 一度も移行されなかったライブラリは、解決時に次を生成します。

```
Because pkg1 doesn't support null safety, version solving failed.
The lower bound of "sdk: '>=2.9.0 <3.0.0'" must be 2.12.0 or higher to enable null safety.
```

そして実行時には、古いエンジン上で `Library doesn't support null safety` を生成します。これを修正する対話型ツール `dart migrate` は Dart 3 で削除されました。Dart 2.19.6 がそれを含む最後の SDK です。したがって唯一サポートされる経路はこうです。まだ Dart 2.x の SDK にいるうちに null safety へ移行し、その後で SDK をアップグレードします。

## 2026 年になぜ移行するのか

- pub.dev 上の現行パッケージはすべて Dart 3 の SDK 制約（`sdk: '>=3.0.0 <4.0.0'`）を要求します。Flutter 2 にとどまると、`http`、`provider`、`go_router`、そしてすべての Firebase プラグインの新しいバージョンから締め出され、セキュリティパッチも受け取れません。
- Dart 3 は records、パターン、シールドクラス、クラス修飾子を解放しました。これらはいずれも Flutter 2 のツールチェーンではコンパイルできません。
- sound null safety は真の正しさの勝利です。コンパイラーが `String` は決して `null` にならないことを証明するため、`NoSuchMethodError: The method '...' was called on null` というクラッシュの一群が出荷不可能になります。本番でこのバグを追いかけたことがあるなら、これは型システムのレベルでの修正です。
- Apple と Google のストア要件（最低 SDK レベル、64 ビット、現行のビルドツール）は、Flutter 2 のビルドが満たせる範囲をはるかに超えて進みました。

## 何が壊れるか

深刻度は、その変更が典型的なアプリを壊す可能性の高さであり、修正の難しさではありません。

| 領域 | 変更 | 深刻度 |
| ---- | ---- | ------ |
| Null safety | unsound モードが Dart 3 で削除された。コードの全行とすべての依存関係が null-safe でなければならない | 高 |
| `dart migrate` ツール | Dart 3 で削除された。Dart 2.19.6 までしか存在しない | 高 |
| SDK 制約 | `pubspec.yaml` の下限は `2.12.0`、次いで `3.0.0` でなければならない | 高 |
| 依存関係 | null-safe なバージョンを持たないパッケージが 1 つでもあると解決全体がブロックされる | 高 |
| 削除された非推奨ウィジェット | `ThemeData.accentColor`、`textSelectionColor`、`toggleableActiveColor` が 3.0 の非推奨整理で削除された | 高 |
| Android ツールチェーン | Gradle、Android Gradle Plugin、Kotlin の最低バージョンがすべて上がった。古い `build.gradle` は失敗する | 高 |
| iOS 最低バージョン | 最低デプロイターゲットが iOS 12 に上がった。32 ビットの armv7 は廃止された | 中 |
| プラグインの埋め込み | まだ v1 の Android 埋め込みのアプリは v2 へ移る必要がある | 中 |

## 事前チェックリスト

コードに触れる前にこれをすべて済ませてください。

- クリーンなベースをコミットし、タグを付けます: `git tag pre-flutter3-migration`。ここには何度も戻ることになります。
- 現在の正確なバージョンを記録します: `flutter --version` と `dart --version`。移行を再現可能にするため、どこかに固定してください。
- まず CI が古い SDK でアプリを緑にビルドすることを確認します。すでに壊れているビルドの上で移行すると数時間を無駄にします。
- 現行のものと並べて Dart 2.19 / Flutter 3.7.12 のツールチェーンをインストールします。プロジェクトごとに切り替えられるよう `fvm`（Flutter Version Management）を使います: `fvm install 3.7.12`。
- 依存関係を棚卸しします: `flutter pub deps --no-dev` を実行し、メンテナンスされていないものを記録します。null-safe なバージョンのない放棄されたパッケージが 1 つあるだけで、移行全体が止まりかねません。

## 移行の手順

1. **移行のために Flutter 3.7.12（Dart 2.19）に固定します。** これは `dart migrate` を持つ最後のツールチェーンです。`fvm` ではプロジェクトで `fvm use 3.7.12` を実行し、次に `fvm flutter --version` で `Dart 2.19.x` を確認します。検証: `fvm flutter pub get` が SDK エラーなしで解決します。

2. **自分のコードを移行する前に依存関係の準備状況を確認します。** `dart pub outdated --mode=null-safety` を実行します。どのパッケージがすでに null-safe なバージョンを持ち、どれが持たないかを示す表が出力されます。検証: すべての直接依存が "Upgradable" または "Resolvable" 列に解決可能な null-safe バージョンを示します。示さないものがあれば、先へ進む前に今すぐ代替を見つけるかフォークします。

3. **依存関係を下から上へ、null-safe なバージョンへ更新します。** 依存関係は順番に移行します。C が B に依存し、B が A に依存するなら、まず A が null-safe でなければなりません。`dart pub upgrade --null-safety` に続けて `dart pub get` を実行すると、ツールが順序を処理します。検証: `pubspec.lock` が null-safe なバージョンを列挙し、`dart pub get` が 0 で終了します。

4. **対話型の移行ツールをコードに対して実行します。** プロジェクトのルートから `dart migrate` を実行します。パッケージ全体を解析し、各型に null 許容性を提案し、推論された `?`、`late`、`required` を 1 つずつ確認できるローカルの Web UI を提供します。誤って推論する箇所では、ソースのヒントマーカーで誘導します。`/*?*/` は nullable を強制し、`/*!*/` は non-nullable を強制し、`/*late*/` は遅延初期化を示し、`/*required*/` は必須パラメーターを示します。検証: 適用する前に、ツールがサマリーで残りの解析エラーがゼロであることを報告します。

5. **移行を適用し、SDK 制約を引き上げます。** "Apply migration" をクリックします。ツールは `.dart` ファイルを書き換え、ヒントコメントを取り除き、`pubspec.yaml` の下限を設定します。

   ```yaml
   # pubspec.yaml -- after the null safety migration, still on Dart 2.19
   environment:
     sdk: '>=2.12.0 <3.0.0'
   ```

   検証: `dart analyze` がエラーを報告せず、`flutter test` が Flutter 3.7.12 で通ります。これを独立したチェックポイントとしてコミットします。これで、まだ古いツールチェーンで動く sound で null-safe なアプリが手に入りました。

6. **現行の Flutter 3.x ツールチェーンへ切り替えます。** ここで 2 つ目の段を進みます。`fvm install stable` と `fvm use stable`（または `3.35.x` のような固定した目標）を実行します。SDK 制約を Dart 3 へ引き上げます。

   ```yaml
   # pubspec.yaml -- targeting the current Flutter 3.x / Dart 3 line
   environment:
     sdk: '>=3.0.0 <4.0.0'
     flutter: '>=3.10.0'
   ```

   `flutter pub get` を実行します。検証: 解決が成功します。"version solving failed" で失敗するなら、ある依存関係にまだ Dart 3 の制約が欠けています。`dart pub outdated` を実行して見つけます。この同じエラーは単純な pubspec の誤りでも出ます。完全な判断フローは [version solving failed の修正](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) を参照してください。

7. **削除された API と非推奨のエラーを `dart fix` で解消します。** Flutter 3.0 は 2.x ラインで非推奨だった API を削除しました。`dart fix --dry-run` でプレビューし、次に `dart fix --apply` で機械的なものを自動で書き換えます。よくある犠牲者はテーマのプロパティです。`ThemeData.accentColor` は消えました。これはまさに、2 から 3 へのアップグレードのほぼすべてがつまずく [accentColor のコンパイルエラー](/ja/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/) です。検証: `flutter analyze` がクリーンです。

8. **Android のビルドツールを直します。** Flutter 2 の `android/` フォルダーは、ほぼ必ず新しい埋め込みには古すぎる Gradle、AGP、Kotlin のバージョンを持っています。`android/gradle/wrapper/gradle-wrapper.properties`、`android/build.gradle`、`android/app/build.gradle` を、現行の Flutter が期待するバージョンへ更新します（使い捨てアプリ用の `flutter create` テンプレートが基準になります）。検証: `flutter build apk --debug` が成功します。`AndroidX conflict` に当たったら、[AndroidX 競合の修正](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/) が解決を案内します。

## 検証

手順 8 の後、両方のプラットフォームでこのスモークテストを実行します。

- `flutter analyze` が問題ゼロを報告します。
- `flutter test` が移行前のベースラインと同じ件数で通ります。件数が減ったら、テストファイルが静かにコンパイルできなかったということです。
- `flutter build apk --release` と `flutter build ios --release --no-codesign` の両方が成功します。
- シミュレーターだけでなく実機で起動し、以前 null エラーでクラッシュしていた画面を操作します。sound null safety がそれらの失敗モードを完全に取り除いているはずです。
- アプリの起動時間とフレームのタイミングをタグ付きのベースラインと比較します。Dart 3 の AOT コンパイラーは一般に高速ですが、想定せず確認してください。

## ロールバック計画

null safety への移行は、コードのレベルでは実質的に一方通行です。型が `?` と `late` を帯びてしまうと、手作業で戻すのは非現実的です。だからこそ手順 5 は独立したコミットです。Dart 3 の段（手順 6 ～ 8）がうまくいかない場合、null safety の作業を巻き戻すのではなく、`git reset --hard` で手順 5 のチェックポイント、すなわち Flutter 3.7.12 で完全に動作する null-safe なアプリへ戻し、ツールチェーンの引き上げを再試行します。新しいビルドが本番でリリースサイクルを 1 回過ごすまで、`pre-flutter3-migration` タグを保持してください。

## 私たちがはまった落とし穴

**null-safe なバージョンのない放棄された依存関係。** これは群を抜いて最も多いブロッカーです。`dart pub outdated --mode=null-safety` がそれを示しますが、解決は人間の仕事です。パッケージを置き換える、フォークして自分で移行する、あるいはベンダリングします。これは事前チェックで決めてください。移行の途中で発見すると後戻りになるからです。

**松葉杖として使われる `late`。** 移行ツールは、初期化子の提供を強いないために、喜んでフィールドを `late` とマークします。すべての `late` は、書き込みより前に読み取るコードパスを待つ、先送りされた `LateInitializationError` です。ツールが挿入したものを 1 つずつ監査し、ライフサイクルが密でない箇所では本物の nullable 型かコンストラクターでの初期化を選んでください。

**`dynamic` はアナライザーから null を隠します。** null safety が守るのは静的に型付けされたコードだけです。`dynamic` として型付けされたフィールドや JSON マップは、依然として `null` を通し、使用箇所でクラッシュします。移行は `fromJson` ファクトリーに本物の型を与える好機です。そこで型を間違えると、型システムが捕まえられない `FormatException` か null クラッシュを投げます。JSON を大量にパースするなら、ここにいるうちにそれらのモデルを引き締めてください。

**プラグインの v1 埋め込み。** v2 の Android 埋め込みより古いアプリは、現行の Flutter で `MainActivity` または `FlutterApplication` のエラーが出てビルドに失敗します。`android/app/src/main/.../MainActivity.kt` を現行のテンプレートから再生成し、古い `GeneratedPluginRegistrant` の参照を削除します。

**中間のツールチェーンを飛ばすこと。** 現行の Flutter をインストールして力ずくで押し通したくなります。`dart migrate` がなければ、アナライザーのエラーから何千もの型を手作業で注釈することになり、それはまさにツールが自動化する作業です。2 つの段を踏んでください。

## 関連

- [Fix: version solving failed in pubspec.yaml](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Flutter: the getter accentColor isn't defined for the class ThemeData](/ja/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/)
- [Fix: Flutter の Android ビルド中の AndroidX 競合](/ja/2026/05/fix-androidx-conflict-during-flutter-android-build/)
- [Flutter アプリを GetX から Riverpod へ移行する方法](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)
- [2026 年の Flutter 状態管理における Provider 対 Riverpod 対 Bloc](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)

## 出典

- [Dart 3 migration guide](https://dart.dev/resources/dart-3-migration) -- Dart 3 では null safety が必須、`dart migrate` は削除、まず Dart 2.19 で移行する。
- [Migrating to null safety](https://github.com/dart-community/migrate-to-null-safety/blob/main/docs/migrate.md) -- `dart pub outdated --mode=null-safety`、`dart migrate`、ヒントマーカー、下から上への依存関係の順序、ツールを含む最後の SDK としての Dart 2.19.6。
- [Flutter breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes) -- 削除・変更された API のバージョン別リスト。
</content>

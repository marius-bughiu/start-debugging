---
title: "修正: pubspec.yaml の Version solving failed"
description: "30 秒で直す方法: エラーの 'because' チェーンを読み、pub を行き詰まらせている 1 つの制約を見つけ、その制約を緩めるか、dependency_overrides エントリを追加します。flutter clean から始めないでください。"
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "pubspec"
lang: "ja"
translationOf: "2026/05/fix-version-solving-failed-in-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-05-17
---

一言で言うと: `Version solving failed` はバグではなく、`dart pub` が `pubspec.yaml` に書かれた制約をすべて同時に満たせないと伝えてきているのです。`because ... depends on ...` 行のチェーンを下から上に読み、満たすことが不可能な唯一の制約 (通常は Dart SDK の下限、またはその利用者の 1 つが必要とするバージョンより古いバージョンに固定されたパッケージ) を見つけ、その制約を緩めるか、`dependency_overrides` エントリを追加して特定のバージョンを強制してください。`flutter clean` や `pubspec.lock` の削除では直りません。

```text
Resolving dependencies...
Because every version of flutter_test from sdk depends on collection 1.19.0
        and my_app depends on collection ^1.18.0, flutter_test from sdk is forbidden.
So, because my_app depends on flutter_test any from sdk, version solving failed.

pub get failed (1; So, because my_app depends on flutter_test any from sdk,
version solving failed.)
exit code 1
```

このガイドは 2026 年 5 月時点の stable チャネルである Dart 3.11 と Flutter 3.41.5 を前提に書かれています。以下で説明するリゾルバーの動作は Dart 2.10 以降 `dart pub` に搭載されている `PubGrub` アルゴリズムと同じものなので、Flutter 3.x または Dart 3.x プロジェクトすべてにそのまま当てはまります。関連するソースコードは [dart-lang/pub](https://github.com/dart-lang/pub) の `lib/src/solver/` 配下にあります。

## エラーの実際の意味

`dart pub get` は [PubGrub](https://github.com/dart-lang/pub/blob/master/doc/solver.md) と呼ばれる SAT 風のソルバーを実行します。これは各依存関係自身の `pubspec.yaml` から取り込まれる推移的な制約も含めて、`pubspec.yaml` 内のすべての制約を巡回し、すべての制約を同時に満たすパッケージバージョンの単一の集合を見つけようとします。そのような集合が存在しない場合、1 回試して諦めることはしません。バックトラックして、どの組み合わせが不可能かについての事実を学び、再試行します。あなたが目にする出力は、解が存在しないという証明の **説明** なのです。

各行は 1 つの事実です。下から上に読んでください: 一番下の行が結論 (`version solving failed`) で、その上の行はその結論を強制した事実のチェーンです。チェーンの一番上にある事実が、あなたが実際に書いた制約であり、おそらく変更が必要な制約です。

エラーメッセージは構造化されています。Pub は関連するすべてのパッケージに名前を付け、正確な制約を出力し、誰がそれを要求しているかを伝えます。落ち着いて読めば、推測する余地はありません。

## 失敗を実証する最小の再現例

新しいパッケージを作成し、推移的な制約が互いに矛盾する 2 つの依存関係を固定します:

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: '>=2.17.0 <3.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.5.0
  some_legacy_package: 0.4.2
```

`flutter pub get` を実行すると、次のようになります:

```text
Because http >=1.0.0 requires SDK version >=3.0.0 <4.0.0
        and my_app requires SDK version >=2.17.0 <3.0.0, http >=1.0.0 is forbidden.
So, because my_app depends on http ^1.5.0, version solving failed.
```

これが実際のプロジェクトでもっともよくあるエラーの形です。解決を壊している制約は、あなた自身の SDK 下限です。あなたが要求したパッケージは問題ありません。あなたがサポートすると宣言した SDK の方が不可能な部分なのです。

もう 1 つの一般的な形は推移的な衝突です:

```text
Because flutter_test from sdk depends on collection 1.19.0
        and riverpod 3.0.0 depends on collection ^1.18.0,
        flutter_test from sdk is incompatible with riverpod 3.0.0.
So, because my_app depends on both flutter_test from sdk and riverpod ^3.0.0,
version solving failed.
```

同じアルゴリズム、別の原因です。ここでは `flutter_test` からの SDK ピンが厳密 (`1.19.0`) で、`riverpod` は `1.18.0` から `2.0.0` 未満までなら何でも受け入れます。`riverpod` を `collection` の下限が `1.19.0` 以上のバージョンにアップグレードすれば両方とも満たせます。修正は選ぶバージョンにあって、制約の構文にあるのではありません。

## 修正、答えである頻度の高い順

以下の手順を順番に実行してください。飛ばさないでください。各ステップは、前のステップでエラーが解決しなかったことを前提にしています。

### 1. エラーを読んでボトルネックを特定する

ターミナル出力を開きます。最初の `Because ...` 行と、チェーンの一番上で名前が付けられている制約を見つけます。それが不可能な事実です。上の SDK の例では `my_app requires SDK version >=2.17.0 <3.0.0` です。推移的な例では `flutter_test from sdk depends on collection 1.19.0` です。

2 つのことを書き留めます:

1. 制約を満たせないパッケージ (**被害者**)。
2. それを縛り付けている制約 (**犯人**)。

両方を特定できない場合、チェーンを十分に注意深く読んでいません。読み直してください。

### 2. SDK の下限を上げる

2026 年では、もっとも一般的な原因は古い SDK 制約です。Dart 3 の機能 (records、patterns、sealed classes、新しい `switch` 式) を使う過去 18 か月以内に公開されたパッケージはすべて、SDK 制約を `^3.0.0` に設定します。`pubspec.yaml` がまだ `>=2.17.0 <3.0.0` と言っているなら、そのパッケージはインストールできません。実際に持っている Dart バージョンに対する caret 構文に更新してください:

```yaml
# pubspec.yaml, after running `dart --version`
environment:
  sdk: ^3.0.0
  flutter: '>=3.10.0'
```

`^3.0.0` (3.0.0 以上 4.0.0 未満) を使い、`^3.11.0` ではなく。下限は「これがテストした中でもっとも古い Dart です」を伝えるものです。ノート PC のバージョンと同じに設定すると、すべての貢献者を理由もなくアップグレードに追い込みます。構文については [pubspec のドキュメント](https://dart.dev/tools/pub/pubspec) を参照してください。

### 3. 競合する依存関係をアップグレードする

犯人がサードパーティのパッケージである場合、2 番目に多い修正は、古いメジャーバージョンに固定されていることです。`flutter pub outdated` は各依存関係、解決されたバージョン、最新バージョンを表示します:

```bash
# Flutter 3.41.5
flutter pub outdated
```

ステップ 1 で名前が出たパッケージを探します。**latest** カラムが現在のものよりも高ければ、次を実行します:

```bash
flutter pub upgrade --major-versions <package_name>
```

これは `pubspec.yaml` 内の制約を最新の互換性のあるメジャーバージョンに書き換え、リゾルバーを再実行します。パッケージが semver に従っていれば、コードの破壊的変更を修正する必要があるかもしれませんが、リゾルバーのエラーは消えます。

### 4. きつすぎる制約を緩める

手で制約を書いて必要以上にきつく固定した場合、広げてください。もっとも多い過剰固定のミスは 2 つあります:

```yaml
# きつすぎ: 厳密ピン
some_package: 1.5.3

# きつすぎ: pre-1.0 バージョンへの caret
some_package: ^0.4.2  # >=0.4.2 <0.5.0 を許可、しばしば狭すぎる
```

メジャーバージョンへの caret (`^1.5.3` は `>=1.5.3 <2.0.0` を許可) か、受け入れられるバージョンをカバーする明示的な範囲 (`'>=0.4.0 <0.6.0'`) に置き換えてください。[Dart の依存制約に関するドキュメント](https://dart.dev/tools/pub/dependencies) は pre-1.0 と post-1.0 両方のパッケージについて caret 構文を説明しています。

### 5. 修正できない推移的な競合には `dependency_overrides` を使う

犯人が、あなたの直接の依存関係 2 つが意見の合わない推移的な依存関係であり、どちらにも競合を解決するリリースがない場合、明示的に上書きしてください。これはルートパッケージの `pubspec.yaml` のみに置きます。あなたが利用する依存関係内の上書きはリゾルバーから無視されます。

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: ^3.0.0

dependencies:
  flutter:
    sdk: flutter
  riverpod: ^3.0.0
  some_other_package: ^2.0.0

dependency_overrides:
  collection: ^1.19.0
```

`dependency_overrides` は大ハンマーです。リゾルバーは上書きされたパッケージの制約を強制するのをやめ、グラフ内で出現するすべての場所であなたのバージョンを使います。`collection` の利用者が `1.19.0` で削除された API に依存していた場合、コンパイルは通りますが実行時に失敗します。強制しているバージョンが本当に互換性があることを確認した後でのみ使い、上流の依存関係が追いついた瞬間に上書きを削除してください。

### 6. 最後の手段: `pubspec.lock` を再生成する

lockfile は解決の下流であって上流ではありません。これを削除しても制約問題は修正できず、これを最初のステップとして推奨するブログ記事のほとんどは間違っています。`pubspec.lock` を削除することが役立つ唯一のタイミングは、すでに `pubspec.yaml` を変更しており、lockfile が新しい互換バージョンを選ぶことをリゾルバーから妨げているときだけです:

```bash
# Flutter 3.41.5
rm pubspec.lock
flutter pub get
```

これはステップ 1 から 5 の後でのみ実行してください。lockfile を再生成しても `pub get` がまだ失敗するなら、制約は依然として不可能であり、実際には何も修正していません。

## 注意点と似て非なるケース

似たエラーを生成する、またはバージョン解決のように見えるがそうではないケースがいくつかあります:

- **`pub get failed (server unavailable)`**: これはネットワークまたはレジストリの問題であって、解決の問題ではありません。設定している場合は `PUB_HOSTED_URL` を確認してください。間違ったミラー URL は 404 を返し、失敗は `version solving failed` に近い形で、しかしそれとしてではなく現れます。
- **`The current Dart SDK version is X.Y.Z. Because my_app requires SDK version ^A.B.C, version solving failed.`**: これがエラーのもっとも直接的な形です。あなた自身の `pubspec.yaml` が宣言しているよりも古い Dart SDK で `flutter pub get` を実行しました。Flutter をアップグレード (`flutter upgrade`) するか、制約を下げてください。
- **`pub get` がローカルでは成功するが CI では失敗する**: あなたの CI の Flutter バージョンがローカルよりも古いのです。CI の Flutter バージョンを一致させるよう固定してください。[1 つの CI パイプラインから複数の Flutter バージョンをターゲットにする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) の記事がマトリックスパターンを扱っています。
- **`pub get` の直後に `Gradle build failed to produce an .apk file`**: これはリゾルバーのエラーではまったくありません。ネイティブビルドステージが失敗しているのです。[Gradle build failed to produce an apk file](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) を参照してください (同じ修正が Flutter Android にも当てはまります)。
- **pre-release バージョンは黙って無視される**: デフォルトではリゾルバーは、たとえ stable な `2.0.0` がなくても、`^1.0.0` を要求しているときに `2.0.0-beta.1` を選びません。同意するには明示的なバージョンを使ってください: `some_package: ^2.0.0-beta.1`。
- **`git:` や `path:` 依存を持つパッケージ**: リゾルバーは依然としてバージョン制約を適用しますが、ソースは pub.dev ではなくあなたが書いた git の ref またはパスです。git 依存でのバージョン解決失敗は、ほぼ常に参照されたブランチの `pubspec.yaml` 自身が壊れていることが原因です。パッケージをローカルにクローンし、その中で `dart pub get` を実行して確認してください。

四半期に 1 回以上 `dependency_overrides` に手を伸ばしているなら、あなたの依存ツリーには構造的な問題があります。同じマイクロドメインから多すぎるパッケージ (HTTP クライアント 3 つ、ステートマネージャー 2 つ) を使っているか、あなたの直接の依存関係が自身の推移的な依存関係に追いついていないかのどちらかです。ツリーを刈り込むことは、個別の制約編集よりも多くのリゾルバーエラーを修正します。

## 関連

- [修正: Dart で JSON をパース中の FormatException: Unexpected character](/ja/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/)
- [修正: Flutter で A RenderFlex overflowed by N pixels](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)
- [1 つの CI パイプラインから複数の Flutter バージョンをターゲットにする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [CPU バウンドな作業のための Dart isolate の書き方](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [DevTools で Flutter アプリのジャンクをプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)

## 出典

- [The pubspec file](https://dart.dev/tools/pub/pubspec) (dart.dev)
- [Package dependencies](https://dart.dev/tools/pub/dependencies) (dart.dev)
- [PubGrub solver design doc](https://github.com/dart-lang/pub/blob/master/doc/solver.md) (dart-lang/pub)
- [dart-lang/pub issue 2470: "version solving failed"](https://github.com/dart-lang/pub/issues/2470) (正規のバグレポートスレッド)
- [dart-lang/pub issue 3755: SDK version constraint edge cases](https://github.com/dart-lang/pub/issues/3755)

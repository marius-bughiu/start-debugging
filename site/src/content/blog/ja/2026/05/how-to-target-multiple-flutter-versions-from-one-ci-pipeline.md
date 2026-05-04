---
title: "1 つの CI パイプラインから複数の Flutter バージョンをターゲットにする方法"
description: "1 つの Flutter プロジェクトを CI で複数の SDK バージョンに対して実行するための実践ガイド: subosito/flutter-action v2 を使った GitHub Actions マトリクス、信頼できる情報源としての FVM 3 の .fvmrc、チャネル固定、キャッシュ、そしてマトリクスが 3 バージョンを超えて成長したときに噛みついてくる落とし穴。"
pubDate: 2026-05-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ci"
  - "github-actions"
  - "fvm"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline"
translatedBy: "claude"
translationDate: 2026-05-04
---

短い答え: プロジェクトの主要な Flutter バージョンを `.fvmrc` に固定し (FVM 3 スタイル)、そのファイルをローカル開発の信頼できる情報源として使います。CI では、関心のある追加の Flutter バージョンに対して `strategy.matrix` ジョブを実行し、それぞれを `subosito/flutter-action@v2` でインストールします (主要ビルド向けに `flutter-version-file: .fvmrc` を読み、マトリクスエントリ向けに明示的な `flutter-version: ${{ matrix.flutter-version }}` を受け付けます)。`cache: true` と `pub-cache: true` の両方を有効にし、`fail-fast: false` でマトリクスを保護して、1 つの壊れたバージョンが他を隠さないようにします。主要バージョンを必須として、マトリクスのバージョンは安定させるまでは情報提供のみとして扱います。

このガイドは 2026 年 5 月時点の Flutter 3.x プロジェクト向けで、`subosito/flutter-action@v2` (最新の v2.x)、FVM 3.2.x、および GitHub ホストの Ubuntu と macOS ランナー上の Flutter SDK 3.27.x と 3.32.x に対して検証されています。1 つのリポジトリ、1 つの `pubspec.yaml`、そして Flutter バージョン間のリグレッションがリリースブランチに到達する前にキャッチするという目標を前提としています。これらのパターンは小さな構文変更で GitLab CI と Bitbucket Pipelines にも翻訳できます。マトリクスの概念は同一です。

## なぜ 1 つのリポジトリを複数の Flutter バージョンに対して実行することが議題になるのか

Flutter には 2 つのリリースチャネル `stable` と `beta` があり、本番でサポートされているのは `stable` のみです。Flutter のドキュメントは新規ユーザーと本番リリースには stable を推奨しており、これは正しく、各チームが 1 つの stable パッチを選んでそこに留まれるなら素敵なことです。実際には、3 つの圧力がチームをそのパスから押し出します:

1. 依存しているパッケージが `environment.flutter` の下限を上げ、新しい下限が今いる場所より 1 マイナー先になる。
2. 必要な Impeller の修正や iOS ビルドの修正を含む新しい stable がリリースされたが、推移的なパッケージがまだそれに対して認証されていない。
3. ライブラリやテンプレート (スターターキット、社内デザインシステム) を出荷していて、ダウンストリームのアプリは各チームが標準化した任意の Flutter で消費するため、`stable - 1`、`stable`、`beta` のいずれでも壊れないことを知る必要がある。

3 つすべてのケースで、答えは同じ退屈な規律です: 開発者のマシンの契約として 1 つのバージョンを選び、関心のあるそれ以外のバージョンは CI マトリクスのエントリとして扱う。これがこの記事の残りの部分が組み立てるモデルです。

`pubspec.yaml` が実際に何を強制するかについての簡単なリマインダーです。`environment.flutter` 制約は `pub` によって下限としてのみチェックされます。[flutter/flutter#107364](https://github.com/flutter/flutter/issues/107364) と [#113169](https://github.com/flutter/flutter/issues/113169) で扱われているとおり、SDK は `flutter:` 制約の上限を強制しないので、`flutter: ">=3.27.0 <3.33.0"` と書いても Flutter 3.40 の開発者があなたのパッケージをインストールするのを止めることはできません。外部メカニズムが必要です。そのメカニズムが、人間向けには FVM、CI 向けには `flutter-action` です。

## ステップ 1: `.fvmrc` をプロジェクトの信頼できる情報源にする

ワークステーションごとに [FVM 3](https://fvm.app/) を一度インストールし、リポジトリのルートからプロジェクトを固定します:

```bash
# FVM 3.2.x, May 2026
dart pub global activate fvm
fvm install 3.32.0
fvm use 3.32.0
```

`fvm use` は `.fvmrc` を書き込み、`.gitignore` を更新して、重い `.fvm/` ディレクトリがコミットされないようにします。[FVM 設定ドキュメント](https://fvm.app/documentation/getting-started/configuration) のとおり、バージョン管理に属するのは `.fvmrc` のみ (および FVM 2 から持っている場合はレガシーの `fvm_config.json`) です。これをコミットすると、ファイルは各開発者と各 CI ジョブが読む契約になります。

最小の `.fvmrc` はこのようになります:

```json
{
  "flutter": "3.32.0",
  "flavors": {
    "next": "3.33.0-1.0.pre",
    "edge": "beta"
  },
  "updateVscodeSettings": true,
  "updateGitIgnore": true
}
```

`flavors` マップは、CI マトリクスに完璧にマッピングできる FVM のコンセプトです: 各エントリはプロジェクトが許容する名前付きの Flutter バージョンです。`next` はグリーンライトを得たい次の stable、`edge` は早期警告シグナル用のライブ beta チャネルです。ローカルでは、開発者は PR を開く前に `fvm use next` を実行してサニティチェックできます。CI では、マトリクスから同じ flavor 名を反復するので、名前は揃ったままです。

## ステップ 2: 1 つのワークフロー、1 つの主要ビルド、1 つのマトリクスジョブ

ほとんどのチームが最初の試みで陥る罠は、すべての Flutter バージョンを同じマトリクスに入れて、すべてを必須として扱うことです。これは実行時間を膨張させ、1 つの不安定な beta が main ブランチを赤くします。スケールするパターンは、同じワークフローファイル内の 2 つのジョブです:

- **主要**ジョブは `.fvmrc` のバージョンのみをインストールし、テスト、ビルド、出荷の完全なパイプラインを実行します。ブランチ保護で必須とされます。
- **互換性**マトリクスジョブは追加の各バージョンをインストールし、アナライザーとテストを実行し、信頼するまでは情報提供のみです。

以下が、`actions/checkout` の v6 (2026 年 5 月時点で最新) と `subosito/flutter-action@v2` を使ったワークフローです:

```yaml
# .github/workflows/flutter-ci.yml
name: Flutter CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: flutter-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  primary:
    name: Primary (.fvmrc)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version-file: .fvmrc
          channel: stable
          cache: true
          pub-cache: true
      - run: flutter --version
      - run: flutter pub get
      - run: dart format --output=none --set-exit-if-changed .
      - run: flutter analyze
      - run: flutter test --coverage

  compat:
    name: Compat (Flutter ${{ matrix.flutter-version }})
    needs: primary
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    continue-on-error: ${{ matrix.experimental }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - flutter-version: "3.27.4"
            channel: stable
            os: ubuntu-latest
            experimental: false
          - flutter-version: "3.32.0"
            channel: stable
            os: macos-latest
            experimental: false
          - flutter-version: "3.33.0-1.0.pre"
            channel: beta
            os: ubuntu-latest
            experimental: true
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: ${{ matrix.flutter-version }}
          channel: ${{ matrix.channel }}
          cache: true
          pub-cache: true
      - run: flutter pub get
      - run: flutter analyze
      - run: flutter test
```

このファイルのいくつかの点は意図的なもので、コピーする前に強調する価値があります。

**`fail-fast: false`** は互換性マトリクスでは必須です。これがないと、最初に失敗したバージョンが他をキャンセルし、目的を打ち消します。1 回の CI 実行で、3.27 が通り、3.32 が失敗し、beta が通ることを見たいのです。「何かが失敗した」だけではありません。

**マトリクスエントリごとの `continue-on-error`** で、beta を許容される赤としてマークできます。ブランチ保護は `Primary (.fvmrc)` チェック名と、必須として分類した互換性エントリを要求すべきです。Beta と「next」はダッシュボードで緑っぽく保たれますが、決してマージをブロックしません。

**`needs: primary`** は小さいですが重要なシーケンシングの詳細です。これは、変更が少なくとも構文的に正常であることを主要ビルドが証明するまで、CI 分がマトリクスで燃やされないことを意味します。30 ジョブのマトリクスではこれが重要です。3 ジョブのマトリクスでもまだ無料の勝利です。

**`concurrency`** は新しいコミットが到着したときに同じ ref 上の進行中の実行をキャンセルします。これがなければ、1 分間に 3 回プッシュする開発者は 3 回の完全なマトリクス実行に対して支払います。

## ステップ 3: バージョン間で実際にヒットするキャッシュ

`subosito/flutter-action@v2` は内部で `actions/cache@v5` を使って Flutter SDK のインストールをキャッシュします。`(os, channel, version, arch)` の各ユニークな組み合わせは別々のキャッシュエントリを生成します。これがまさに望みです。デフォルトのキャッシュキーはこれらのトークンの関数なので、3 バージョンマトリクスは 3 つの SDK キャッシュを生成し、2 OS × 3 バージョンマトリクスは 6 つを生成します。これはカスタマイズを始めるまでは大丈夫です。

知っておく価値のある 2 つのつまみ:

- `cache: true` は SDK 自体をキャッシュします。Ubuntu では実行ごとに約 90 秒節約し、macOS ではインストールが Xcode 関連のアーティファクトを引っ張るのでさらに節約できます。
- `pub-cache: true` は `~/.pub-cache` をキャッシュします。これは増分変更にとってより大きな勝利です。80 個の推移的パッケージを持つ典型的な Flutter アプリは、コールド `pub get` に 25-40 秒、ウォームでは 5 秒未満かかります。

依存関係を共有する複数の Flutter プロジェクトを持つモノレポがある場合は、デフォルトだけでなく、関連するすべての `pubspec.lock` ファイルのハッシュを含む `cache-key` と `pub-cache-key` を設定します。そうしないと、各サブプロジェクトが他のキャッシュを上書きします。アクションはこのために `:hash:` と `:sha256:` トークンを公開しています。構文については [README](https://github.com/subosito/flutter-action) を参照してください。

マトリクスのキャッシュキーに**属さない**のは、`*-pre` ビルドに固定しているときの Flutter SDK チャネル名です。Beta タグは時々再ビルドされるので、`*-pre` バージョンでのキャッシュヒットが古いバイナリを提供する可能性があります。最も簡単な修正は、`experimental: true` エントリのキャッシュをスキップすることです:

```yaml
- uses: subosito/flutter-action@v2
  with:
    flutter-version: ${{ matrix.flutter-version }}
    channel: ${{ matrix.channel }}
    cache: ${{ !matrix.experimental }}
    pub-cache: ${{ !matrix.experimental }}
```

beta エントリのインストール時間を 1 分諦めて、beta ビルドが再現可能であるという信頼を得ます。

## ステップ 4: `.fvmrc` とマトリクスを配線する

FVM の flavors とマトリクスを組み合わせる要点は、名前が揃うことです。新しい互換性ターゲットを追加することは、`.fvmrc` への 1 行の変更とワークフローへの 1 行の変更であるべきです。手動の調整なしに同期させるには、ジョブ時にファイルからマトリクスを生成します。GitHub Actions は、JSON マトリクスを発行する小さなブートストラップジョブでこれを行えます:

```yaml
  matrix-builder:
    name: Build matrix from .fvmrc
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.build.outputs.matrix }}
    steps:
      - uses: actions/checkout@v6
      - id: build
        run: |
          MATRIX=$(jq -c '
            {
              include: (
                .flavors // {} | to_entries
                | map({
                    "flutter-version": .value,
                    "channel": (if (.value | test("pre|dev")) then "beta" else "stable" end),
                    "os": "ubuntu-latest",
                    "experimental": (.key == "edge")
                  })
              )
            }' .fvmrc)
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"

  compat:
    needs: [primary, matrix-builder]
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.matrix-builder.outputs.matrix) }}
    # ... same steps as before
```

これで `"perf-investigation": "3.31.2"` を `.fvmrc` に追加すると、次の CI 実行で互換性ジョブが自動的に追加されます。第二の信頼できる情報源はなく、ローカル FVM が試すものと CI が検証するものの間にドリフトはありません。GitHub Action の `flutter-actions/pubspec-matrix-action` は、インラインの `jq` よりメンテナンスされた依存関係を使いたい場合に同様のことを行います。両方のアプローチが機能します。

## 2 つ目のマトリクスエントリの後に現れる落とし穴

マトリクスが 3 バージョンを超えると、これらのうち少なくとも 1 つに当たります。

**Pub キャッシュの汚染。** より新しい Flutter シンボルに条件付きインポートを使用するパッケージは、3.27 と 3.32 で異なる解決をする可能性があります。両方のバージョンが `pub-cache` を共有している場合、3.32 によって書かれたロックファイルが 3.27 に提供され、間違ったコードパスで「動作する」ビルドが生成される可能性があります。Flutter バージョントークン (`:version:`) を含む `pub-cache-key` を使って、それらを分離してください。コストはより冷たいキャッシュです。利益は再現性です。

**`pubspec.lock` のチャーン。** `pubspec.lock` をコミットしている場合 (アプリケーションリポジトリには推奨、ライブラリには非推奨)、マトリクスは Flutter バージョンごとに異なる方法でそれを再生成し、`.fvmrc` のバージョンで実行している開発者は、CI のマトリクスエントリが見るものとは異なるロックを見るでしょう。修正は、マトリクスジョブでロックの書き戻しをスキップすることです: `flutter pub get` に `--enforce-lockfile` を渡します。これは、ロックを変更する代わりに、解決の発散時に失敗します。これはマトリクスジョブにのみ適用してください。主要ジョブは依然として更新を許可すべきで、Renovate や Dependabot の PR が緑に到達できるようにします。

**iOS ビルドと beta チャネル。** `subosito/flutter-action@v2` は Flutter SDK をインストールしますが、`macos-latest` の Xcode バージョンは変更しません。ランナーの Xcode は Flutter の beta チャネルとは異なるケイデンスでアップグレードされ、Flutter beta はランナーがまだ出荷していない Xcode を要求することがあります。iOS ビルドステップ (`flutter build ipa --no-codesign`) が beta でのみ失敗し始めたら、コードが壊れていると仮定する前に、ランナーの Xcode を [`flutter doctor`](https://docs.flutter.dev/get-started/install) の要件と照らし合わせて確認してください。`macos-latest` の代わりに `runs-on: macos-15` でランナーを固定すると、その変数を制御できます。

**アーキテクチャのデフォルト。** 2026 年 5 月時点で、GitHub ホストランナーは macOS ではデフォルトで ARM64、Ubuntu では x64 です。ネイティブプラグインをビルドする場合、キャッシュキーのアーキテクチャトークンが重要です。そうでなければ、Apple Silicon キャッシュが将来の移行で x64 ランナーに提供される可能性があります。アクションのデフォルトの `cache-key` はこの理由で `:arch:` を含んでいます。カスタマイズするときに削除しないでください。

**Dart SDK のスキュー。** 各 Flutter バージョンは特定の Dart SDK を出荷します。Flutter 3.32 (Dart 3.7) での `dart format` の実行は、Flutter 3.27 (Dart 3.5) とは少数のエッジケースで異なるフォーマットを生成します。古いバージョンでの偽の「format check failed」レポートを避けるために、フォーマットはマトリクスではなく主要ジョブでのみ実行してください。同じ論理が lint にも適用されます: Dart 3.7 で導入された新しい lint は、3.32 では発火し、3.27 では発火しません。プロジェクトレベルの `analysis_options.yaml` を使い、新しい lint は最も古いマトリクスバージョンがそれをサポートしてからのみ有効にしてください。

## いつバージョンの追加を止めるか

これらすべての要点はリグレッションを早くキャッチすることであり、徹底的にテストすることではありません。3 つや 4 つを超えるバージョンのマトリクスは、通常、チームがアップグレードへの自信ではなく、アップグレードを恐れていることを意味します。マトリクスが 5 つに成長したら、6 か月でリグレッションをキャッチしていないエントリはどれかを尋ねてください。そのエントリはおそらく引退すべきです。ほとんどのアプリにとって正しいケイデンスは `現在の stable`、`発表されたときの次の stable`、`beta` で、これはステップ 4 の matrix-builder スクリプトが `.fvmrc` が宣言するものに制限されることを意味します。

報われる規律は、そもそも [Flutter SDK を再現可能に固定する](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) を機能させるのと同じです: 関心のあるバージョンを宣言し、それらのバージョンのみをインストールし、そのセット外のものを契約外として扱います。マトリクスは強制です。

## 関連

- [Flutter 3.38.6 と engine.version の bump: 固定すれば再現可能なビルドがより簡単になる](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) は、単一のチャネル内であっても SDK を固定することがなぜ重要かをカバーしています。
- [Dart 3.12 dev タグは速く動いている](/ja/2026/01/dart-3-12-dev-tags-are-moving-fast-how-to-read-them-and-what-to-do-as-a-flutter-3-x-developer/) は、Dart の dev タグのケイデンスが Flutter チャネルの選択とどう相互作用するかを説明しています。
- [Windows から Flutter iOS をデバッグする](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) は、CI が macOS をカバーする必要があるが開発者が日常的に Mac を使わないチームのための姉妹編です。
- [FlutterGuard CLI: Flutter 3.x アプリ向けの高速な「攻撃者は何を抽出できるか」チェック](/ja/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) は、マトリクスが安定したら主要ジョブに追加するのに有用な追加ステップです。

## ソースリンク

- [subosito/flutter-action README](https://github.com/subosito/flutter-action)
- [flutter-actions/setup-flutter](https://github.com/flutter-actions/setup-flutter) (v2 が遅れた場合のメンテナンスされた代替手段)
- [FVM 3 ドキュメント](https://fvm.app/documentation/getting-started/configuration)
- [Flutter pubspec オプション](https://docs.flutter.dev/tools/pubspec)
- [Flutter のアップグレード](https://docs.flutter.dev/install/upgrade)
- [flutter/flutter#107364: SDK 制約の上限が強制されない](https://github.com/flutter/flutter/issues/107364)
- [flutter/flutter#113169: pubspec.yaml で正確な Flutter バージョンを設定しても機能しない](https://github.com/flutter/flutter/issues/113169)

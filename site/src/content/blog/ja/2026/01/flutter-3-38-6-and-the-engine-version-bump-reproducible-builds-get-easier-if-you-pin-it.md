---
title: "Flutter 3.38.6 と `engine.version` のバンプ: 再現可能なビルドが楽になります (固定すれば)"
description: "Flutter 3.38.6 は engine.version をバンプし、それが再現可能なビルドにとって重要です。CI で SDK を固定し、エンジンドリフトを避け、コード変更なしでビルドが壊れたときに「何が変わったか」を診断する方法を学びます。"
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "ja"
translationOf: "2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it"
translatedBy: "claude"
translationDate: 2026-04-30
---
Flutter 3.38.6 は「engine.version bump」というリリースエントリで着地し、その小さな一文は見た目以上に重要です。CI ビルドが、あるマシンが少し違うエンジンアーティファクトを拾ったためにドリフトしたことがあるなら、固定することは「動く」と「来週このビルドを再現できる」の違いになります。

リリースエントリ: [https://github.com/flutter/flutter/releases/tag/3.38.6](https://github.com/flutter/flutter/releases/tag/3.38.6)

## `engine.version` は SDK の背後に隠れた固定値

`flutter --version` を実行すると、フレームワークのバージョンを選んでいるだけではありません。特定のエンジンリビジョンを暗黙的に選択しており、そのリビジョンが以下を制御します:

-   **Skia とレンダリング動作**
-   **プラットフォームエンベダーの変更**
-   **エンジンアーティファクトに依存するツールの動作**

`engine.version` の更新は Flutter が「この SDK タグはこのエンジンリビジョンにマップされる」と言っていることです。言い換えれば、これは再現性のシグナルであり、単なるリリースプロセスの雑用ではありません。

## CI で Flutter 3.38.6 を退屈な方法で固定する

退屈な方法が最高の方法です: バージョンマネージャーを使い、欲しいバージョンをコミットします。

FVM を使っているなら、Flutter を明示的に固定し、ドリフトしたら CI を失敗させます:

```bash
# One-time on your machine
fvm install 3.38.6
fvm use 3.38.6 --force

# In CI (example: verify the version)
fvm flutter --version
```

FVM を使っていなくても、重要な考えは同じです: 「ランナーにインストールされているもの」にエンジンを決めさせないでください。Flutter 3.38.6 をパイプラインの一部としてインストールし、キャッシュし、`flutter --version` をログに出して、ドリフトを診断できるようにします。

## 「なぜビルドが変わったのか」チェックリスト

Flutter のビルドがコード変更なしで変わるとき、次の順序でチェックします:

-   **Flutter SDK タグ**: まだ 3.38.6 ですか?
-   **エンジンリビジョン**: `flutter --version -v` は同じエンジンコミットを示しますか?
-   **Dart バージョン**: SDK ドリフトはアナライザーとランタイムの動作を変えることがあります。
-   **ビルド環境**: Xcode/Android Gradle Plugin のバージョンは差異を生むことがあります。

`engine.version` を強調するのが好きな理由は、2 番目の項目を実行可能にするからです。Flutter SDK を不変の入力として扱えば、残りのパイプラインは推論しやすくなります。

複数のアプリを保守しているなら、固定を見えるようにしてください。`README` のスニペットや、Flutter 3.38.6 を検証する CI チェックは安価で、誰かが初めて「何が変わった?」と聞くときに何時間も節約できます。

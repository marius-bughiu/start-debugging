---
title: "riverpod vs flutter_riverpod vs hooks_riverpod: 実際にどのパッケージが必要ですか？"
description: "ほぼすべての Flutter アプリには flutter_riverpod をインストールします。riverpod は純粋な Dart コードのみ、hooks_riverpod は既に flutter_hooks を使っている場合のみ使用します。"
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
lang: "ja"
translationOf: "2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need"
translatedBy: "claude"
translationDate: 2026-07-23
---

pub.dev に `riverpod`、`flutter_riverpod`、`hooks_riverpod` が表示され、どれを追加すべきか判断できない場合、ほぼすべての Flutter アプリでの答えは `flutter_riverpod` です。`riverpod`（`flutter_` プレフィックスなし）を追加するのは、CLI やサーバーのように Flutter への依存がない純粋な Dart を書くときだけです。`hooks_riverpod` を追加するのは、既に `flutter_hooks` パッケージを使っていて `HookConsumerWidget` が必要な場合だけです。これら 3 つは競合する状態管理ツールではありません。同じライブラリのレイヤーであり、間違ったものを選んでも、それはわずかに誤った import になるだけで、別のアーキテクチャになるわけではありません。ここでのすべてのバージョンは Riverpod 3.3.2（3.0 系は 2025-09-10 にリリース）、Flutter 3.44、Dart 3.12 を対象としています。

## これらはライバルではなくレイヤーです

混乱は、pub.dev がこれらを Provider と Bloc のような代替候補であるかのように並べて表示することから生じます。そうではありません。`riverpod` は中心的なエンジンで、純粋な Dart で書かれており、Flutter の import は一切ありません。`flutter_riverpod` はそのエンジンを取り込み、Flutter の接着剤を追加します。`ProviderScope`、`ConsumerWidget`、`Consumer`、そして `ref.watch` を呼び出す対象の `WidgetRef` です。`hooks_riverpod` は `flutter_riverpod` を取り込み、その上にもう 1 つを追加します。独立したパッケージ `flutter_hooks` との統合で、`HookConsumerWidget` を公開します。

各パッケージは、その下位のパッケージを再エクスポートします。`flutter_riverpod` を追加すると、`riverpod` のすべても、それを列挙せずに得られます。`hooks_riverpod` を追加すると、`flutter_riverpod` のすべても得られます。だからこそ、これらを同時に 2 つ以上インストールすることはなく、`flutter_riverpod` をインストールしてから `package:riverpod/riverpod.dart` から import するのは、紛らわしいシンボル重複エラーを生む誤りなのです。

## 機能マトリクス

| 機能 | `riverpod` 3.3.2 | `flutter_riverpod` 3.3.2 | `hooks_riverpod` 3.3.2 |
| --- | --- | --- | --- |
| Flutter に依存する | いいえ | はい | はい |
| プロバイダーエンジン（`Provider`、`Notifier`、`ref.watch`） | はい | はい | はい |
| `ProviderScope` ウィジェット | いいえ | はい | はい |
| `ConsumerWidget` / `Consumer` | いいえ | はい | はい |
| `HookConsumerWidget` / `HookConsumer` | いいえ | いいえ | はい |
| `flutter_hooks` を併せて必要とする | いいえ | いいえ | はい |
| 下位のパッケージを再エクスポートする | -- | `riverpod` | `flutter_riverpod` |
| 適した用途 | 純粋な Dart コード | ほとんどの Flutter アプリ | 既に hooks を使う Flutter アプリ |

`AsyncValue` 型、`ref.listen`、`.autoDispose` のようなプロバイダー修飾子、そして 3.0 で追加された自動リトライの挙動は、すべて中心の `riverpod` パッケージに存在します。そのため、それらを持つ各行は 3 つの間で同一です。唯一の実質的な違いは、ウィジェットの基底クラスと Flutter への依存です。

## flutter_riverpod をインストールすべきとき

これがデフォルトであり、大多数のアプリをカバーします。

- 通常の Flutter アプリケーション（モバイル、デスクトップ、または web）を構築していて、ルートに `ProviderScope`、画面に `ConsumerWidget` を置きたい。
- `flutter_hooks` パッケージを使っておらず、使う予定もない。
- Flutter との完全な統合を得たうえで、依存の表面積を最小にしたい。

インストールは 1 つのコマンドです。

```bash
# Flutter 3.44, flutter_riverpod 3.3.2
flutter pub add flutter_riverpod
```

最小限の動作するウィジェットは次のようになります。

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.2
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;
  void increment() => state++;
}

void main() {
  // ProviderScope comes from flutter_riverpod
  runApp(const ProviderScope(child: MyApp()));
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Text('$count');
  }
}
```

`ProviderScope`、`ConsumerWidget`、`WidgetRef` はすべて `flutter_riverpod` が提供します。`NotifierProvider`、`Notifier`、`state` は、`flutter_riverpod` が再エクスポートする中心エンジンに由来します。Flutter アプリで `package:riverpod/riverpod.dart` を直接 import することは決してありません。

## 素の riverpod をインストールすべきとき

素の `riverpod` パッケージに手を伸ばすのは、プロジェクトに Flutter がまったく存在しない場合だけです。

- Flutter アプリとプロバイダーベースのロジックを共有する Dart のコマンドラインツール。
- バックエンドで Riverpod の依存グラフを使いたい `dart_frog` や `shelf` のサーバー。
- 他のアプリが依存する純粋な Dart パッケージで、Flutter を引き込むのが誤りとなる場合。

```bash
# Dart 3.12, riverpod 3.3.2
dart pub add riverpod
```

Dart のみのコンテキストにはウィジェットツリーがないため、`ProviderScope` の代わりに、自分で `ProviderContainer` を構築してそこから読み取ります。

```dart
// Dart 3.12, riverpod 3.3.2 (no Flutter)
import 'package:riverpod/riverpod.dart';

final greetingProvider = Provider<String>((ref) => 'hello from Dart');

void main() {
  final container = ProviderContainer();
  print(container.read(greetingProvider)); // hello from Dart
  container.dispose();
}
```

プロジェクトの `pubspec.yaml` に dependencies の下で `flutter:` がある場合、これはほぼ確実にあなたが欲しいパッケージではありません。素の `riverpod` を Flutter アプリに追加し、その後 `ConsumerWidget` と `ProviderScope` が解決されない理由を不思議に思うのは、最もよくある Riverpod のセットアップミスの 1 つです。

## hooks_riverpod をインストールすべきとき

`hooks_riverpod` をインストールするのは、既に `flutter_hooks` にコミットしていて、プロバイダーを読む同じウィジェットの中で hooks を使いたい場合だけです。

重要な事実として、`flutter_hooks` と Riverpod は 2 つの独立したパッケージです。`flutter_hooks` は React の hooks を移植したもので、ローカルなウィジェットの状態、つまり単一のウィジェットに限定された `TextEditingController` や `AnimationController` のようなものを管理します。Riverpod は共有されるアプリケーションの状態を管理します。両者は異なる問題を解決し、どちらか一方を他方なしで使えます。`hooks_riverpod` は、単一のウィジェットがクラス継承の衝突なしに両方を行えるようにするためだけに存在します。

その衝突は現実のものです。`HookWidget`（`flutter_hooks` 由来）と `ConsumerWidget`（`flutter_riverpod` 由来）はどちらも基底クラスであり、Dart のクラスは 1 つのスーパークラスしか拡張できません。`class X extends HookWidget, ConsumerWidget` とは書けません。`hooks_riverpod` はこれを、両方を同時に兼ねる単一の基底クラス `HookConsumerWidget` を提供することで解決します。

```dart
// Flutter 3.44, hooks_riverpod 3.3.2, flutter_hooks 0.21.2
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

class SearchField extends HookConsumerWidget {
  const SearchField({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // useTextEditingController is a hook: local widget state
    final controller = useTextEditingController();
    // ref.watch is Riverpod: shared app state
    final results = ref.watch(searchResultsProvider);

    return TextField(controller: controller);
  }
}
```

注意すべき点が 2 つあります。1 つ目、`hooks_riverpod` は `flutter_hooks` を同梱しないため、両方を追加する必要があります。

```bash
# Flutter 3.44
flutter pub add hooks_riverpod
flutter pub add flutter_hooks
```

2 つ目、`hooks_riverpod` は `flutter_riverpod` を再エクスポートするため、`pubspec.yaml` に `flutter_riverpod` を併記する必要はなく、併記すべきでもありません。`hooks_riverpod` の 1 つの import で、`ProviderScope`、`ConsumerWidget`、`HookConsumerWidget` がすべてまとめて得られます。プロバイダーを読むだけのファイルは、依然として素の `ConsumerWidget` を拡張できます。`HookConsumerWidget` に手を伸ばすのは、hooks も呼び出す特定のファイルの中だけです。

公式ドキュメントは初心者向けにこの点をはっきり述べています。Riverpod が初めてなら、hooks から始めないでください。それは、すでに馴染みのないモデルの上に、2 つ目のメンタルモデルを重ねることになります。まず `flutter_riverpod` を学び、ローカルな状態のために hooks が欲しいと気づいたときに限って、後から `hooks_riverpod` を採用してください。現在コントローラーを手作業で管理しているなら、[メモリリークを避けるための Flutter コントローラーの破棄](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) にある破棄の規律こそ、hooks が取り除こうとしているまさにそのボイラープレートであり、それが hooks を採用する正直な理由です。

## アノテーションのパッケージはランタイムパッケージを置き換えますか？

よくある次の質問です。`@riverpod` の codegen のために `riverpod_annotation` を追加したら、それでも `flutter_riverpod` は必要ですか？ はい。アノテーションのパッケージが提供するのは、`@riverpod` マーカーと、ジェネレーターがそれに対して生成する型だけです。ランタイムは含まれません。`ProviderScope` も、`Notifier` も、`ref` もありません。アプリは依然として 3 つのランタイムパッケージのいずれかの上で動作し、生成されたコードはそこから import します。したがって codegen を使う Flutter アプリは、`flutter_riverpod`（ランタイム）と `riverpod_annotation`（アノテーション）の両方に依存し、一方が他方の代わりになるわけではありません。

同じ「ランタイムパッケージは 1 つ」という規則はテストでも成り立ちます。`ProviderScope` を pump するウィジェットテストは（`flutter_test` を通じて）`flutter_riverpod` を使い、`ProviderContainer` を立ち上げる純粋な Dart のユニットテストは素の `riverpod` を使います。Riverpod のために別のテスト用パッケージを追加することはありません。テストに必要な `ProviderContainer` と `overrides` は、インストール済みのランタイムパッケージの中に既に含まれています。

## 本当に人をつまずかせる落とし穴: codegen のパッケージは別々にバージョン管理される

3.x 時代の経験豊富な Riverpod ユーザーさえ驚かせる部分がここです。ランタイムパッケージ（`riverpod`、`flutter_riverpod`、`hooks_riverpod`）は 3.3.x 系にありますが、コード生成のパッケージはまったく別のメジャーバージョンにあります。

| パッケージ | 役割 | バージョン（2026-07） |
| --- | --- | --- |
| `flutter_riverpod` | runtime | 3.3.2 |
| `hooks_riverpod` | runtime | 3.3.2 |
| `riverpod` | runtime | 3.3.2 |
| `riverpod_annotation` | codegen のアノテーション | 4.0.3 |
| `riverpod_generator` | codegen (dev) | 4.0.4 |
| `riverpod_lint` | lint ルール (dev) | 3.x |

`@riverpod` アノテーションを使ってプロバイダーを生成する場合、インストールするパッケージは 1 つではなく 4 つです。`riverpod_annotation` は通常の依存で、`riverpod_generator` と `build_runner` は開発依存です。

```bash
# Flutter 3.44, Riverpod 3.x
flutter pub add flutter_riverpod riverpod_annotation
flutter pub add dev:riverpod_generator dev:build_runner
flutter pub add dev:custom_lint dev:riverpod_lint   # optional, for lint rules
```

その後、次のコマンドで生成します。

```bash
# runs the generator once, or use `watch` to keep it running
dart run build_runner watch -d
```

ランタイムに合わせようとして `riverpod_annotation` を `^3.0.0` に固定しないでください。3.3.x のランタイムに対応するのは 4.x のアノテーション系です。バージョン番号は意図的に切り離されています。ジェネレーターが独自のペースで進化するためです。制約の解決は `flutter pub add` に任せ、「揃える」ために手作業で編集しないでください。揃うようには作られていないからです。これは、新規作成した Riverpod 3 プロジェクトで最もよくある `pub get` の失敗です。

コード生成は任意です。この記事のすべては、それなしで動作します。アノテーションのアプローチは主に、プロバイダー型のボイラープレート（`NotifierProvider<Counter, int>`）を手書きする手間を省くもので、新規プロジェクトの良いデフォルトですが、どのランタイムパッケージをインストールするかとは別の判断です。

## 実際に打ち込むもの

説明を取り除けば、判断は短いものです。

- Flutter アプリを構築、hooks なし: `flutter pub add flutter_riverpod`。90% の場合、これがあなたです。
- 純粋な Dart、Flutter なし: `dart pub add riverpod`。
- 既に `flutter_hooks` を使う Flutter アプリ: `flutter pub add hooks_riverpod flutter_hooks`。
- 上記のいずれかの上で `@riverpod` アノテーションを使う: `riverpod_annotation` に加えて開発依存の `riverpod_generator` と `build_runner` を追加し、リゾルバーに 4.x 系を選ばせます。

どのランタイムパッケージを選んでも、プロバイダー、`Notifier` の API、`AsyncValue` の振る舞いは同一です。すべて同じ中心エンジンに由来するからです。あなたが選んでいるのは、その上に Flutter の接着剤と hooks サポートをどれだけ重ねるか、それだけです。それが決まれば、本当の学びは API そのものにあります。[Riverpod の AsyncValue が FutureBuilder や StreamBuilder とどう比較されるか](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)、[非同期ギャップの後に ref.mounted を確認する方法](/ja/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)、そして新しい [3.0 でのプロバイダーの自動リトライ](/ja/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/) がエラー処理をどう変えるか、です。Riverpod を使うかどうかをまだ決めかねているなら、[Provider vs Riverpod vs Bloc の比較](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) がその判断を下します。旧系から移行するなら、[Riverpod 2.x から 3.0 への移行ガイド](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) が破壊的変更をカバーします。

## 出典

- [Riverpod: Getting started](https://riverpod.dev/docs/introduction/getting_started) -- `riverpod`、`flutter_riverpod`、`hooks_riverpod`、および codegen パッケージの公式インストールコマンド。
- [Riverpod: About hooks](https://riverpod.dev/docs/concepts/about_hooks) -- `flutter_hooks`、`flutter_riverpod`、`HookConsumerWidget` の関係と、初心者への助言。
- [riverpod_generator changelog](https://pub.dev/packages/riverpod_generator/changelog) -- 3.3.x ランタイムと対になる 4.x の codegen 系を確認できます。
- [pub.dev の flutter_hooks](https://pub.dev/packages/flutter_hooks) -- `hooks_riverpod` が統合する独立した hooks パッケージ。

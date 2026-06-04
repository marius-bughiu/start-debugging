---
title: "2026 年の Flutter 状態管理における Provider vs Riverpod vs Bloc"
description: "2026 年のほとんどの新しい Flutter アプリには Riverpod を選びましょう。大規模チームが強制されたイベント駆動の構造を求める場合は Bloc を、Provider はレガシーコードのためだけに残します。"
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "bloc"
lang: "ja"
translationOf: "2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026"
translatedBy: "claude"
translationDate: 2026-06-04
---

2026 年に新しい Flutter アプリを始めるにあたって Provider、Riverpod、Bloc のどれにするか決められないなら、短い答えは Riverpod です。Riverpod 3.3.1（3.0 系は 2025-09-10 にリリース）では、コンパイル時に安全で、`BuildContext` なしでテストでき、コード生成のパスがかつて反対理由の主役だった boilerplate のほぼすべてを取り除きます。強制されたイベント駆動の契約と追跡可能な状態の履歴から恩恵を受ける大規模チームがあるなら、Bloc（`flutter_bloc` 9.1.1）を使いましょう。Provider（6.1.5）は、すでにコードベースにある場合や、誰かに基盤となる `InheritedWidget` のモデルを教える場合だけ残します。ここでの例はすべて Flutter 3.44 と Dart 3.12 を対象にしています。

## 3 つのパッケージは同じ種類のツールではありません

比較する前に、これらのライブラリが重なり合いつつも異なる問題を解いていると理解しておくと役立ちます。

Provider は Flutter 自身の `InheritedWidget` の上に乗る、薄くてよくできたラッパーです。依存性注入と再ビルドの伝播を行い、ほぼそれだけです。状態クラスは通常、手で書く `ChangeNotifier` です。Flutter の公式ドキュメントが教育的な例を必要としたときに採用したパッケージであり、だからこそ多くのチュートリアルがこれを使っています。

Riverpod は Provider の作者が次に作ったもので、Provider の構造的な問題、つまり実行時の `ProviderNotFoundException`、ツリー内のウィジェット位置への依存、純粋な Dart から状態を読めないことを修正するために作られました。Riverpod のプロバイダーはウィジェットツリーの外に存在するため、どこからでも到達でき、コンパイル時に解決されます。

Bloc はまずパターンであり、その次にパッケージです。あらゆる変更を、コンポーネントに流れ込み新しい不変の状態を生み出す明示的なイベントとしてモデル化するよう促します。その儀式こそが要点で、大規模チームでは強制された `Event -> Bloc -> State` のパイプラインが振る舞いを予測可能でレビュー可能にします。

## 機能マトリクス

| 機能 | Provider 6.1.5 | Riverpod 3.3.1 | Bloc 9.1.1 |
| --- | --- | --- | --- |
| メンタルモデル | `InheritedWidget` + `ChangeNotifier` | ツリー外のプロバイダー | イベント駆動、不変の状態 |
| コンパイル時の安全性 | いいえ（実行時のルックアップ） | はい | はい |
| 読み取りに `BuildContext` が必要 | はい | いいえ | いいえ（`context.read` または直接） |
| Boilerplate | 少ない | codegen で少ない | 多い |
| テスト容易性 | ウィジェットのポンプが必要 | 純粋な Dart、ウィジェットツリー不要 | 純粋な Dart、`bloc_test` ヘルパー |
| 非同期 / ローディング状態 | 手動 | `AsyncValue`、組み込み | 手動の状態または `emit` |
| 失敗時の自動リトライ | いいえ | はい（3.0 以降） | いいえ |
| 状態の追跡可能性 | 弱い | 中程度 | 強い（すべての遷移を観測可能） |
| 学習曲線 | 緩やか | 中程度 | 急 |
| 最適な用途 | レガシー、チュートリアル | ほとんどの新規アプリ | 大規模チーム、複雑なフロー |

最も重要な行は「コンパイル時の安全性」です。誤って構成された Provider は実行時に `ProviderNotFoundException` を投げ、しばしばそれが欠けている画面でのみ発生します。Riverpod と Bloc はどちらも、その種の誤りをアプリが動く前に表面化させます。

## 同じカウンターを 3 つすべてで

カウンターはエルゴノミクスを直接比較するのに十分なほど小さいです。それぞれがどれだけのコードを必要とし、状態がどこに存在するかに注目してください。

### Provider

```dart
// Flutter 3.44, provider 6.1.5
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class CounterModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  void increment() {
    _count++;
    notifyListeners();
  }
}

// Register it above the widgets that need it.
ChangeNotifierProvider(
  create: (_) => CounterModel(),
  child: const CounterPage(),
);

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final count = context.watch<CounterModel>().count;
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.read<CounterModel>().increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

`context` への依存に注目してください。`CounterPage` がその上に `ChangeNotifierProvider` なしでレンダリングされると、`context.watch<CounterModel>()` は実行時に例外を投げます。

### Riverpod

```dart
// Flutter 3.44, flutter_riverpod 3.3.1, riverpod_annotation
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => ref.read(counterProvider.notifier).increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

`counterProvider` は生成され、グローバルに到達可能です。間違えるようなツリー位置はなく、`ref` はコンパイル時に解決されます。アプリを一度 `ProviderScope` で包めば完了です。

### Bloc

```dart
// Flutter 3.44, flutter_bloc 9.1.1, equatable
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

// Events
sealed class CounterEvent {}
class Increment extends CounterEvent {}

// Bloc: Event in, int state out.
class CounterBloc extends Bloc<CounterEvent, int> {
  CounterBloc() : super(0) {
    on<Increment>((event, emit) => emit(state + 1));
  }
}

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => CounterBloc(),
      child: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: BlocBuilder<CounterBloc, int>(
              builder: (context, count) => Text('$count'),
            ),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => context.read<CounterBloc>().add(Increment()),
            child: const Icon(Icons.add),
          ),
        ),
      ),
    );
  }
}
```

Bloc はカウンターでは最も冗長で、この比較は Bloc に対して不公平です。Bloc の価値は、イベントが 1 つではなく 20 個、状態が 10 個あるときに現れます。`Increment` イベントはアプリの履歴の記録です。`BlocObserver` を取り付ければすべての遷移をログに残せて、これは複雑な画面をデバッグするときにまさに欲しいものです。

## Riverpod を選ぶべきとき

- **レガシーの制約がない 2026 年の新規アプリ。** これがデフォルトです。Riverpod はコンパイル時の安全性、`pumpWidget` なしのテスト、そして `AsyncValue` による非同期処理を最初から提供します。非同期がどれだけきれいになるかは、[AsyncValue を使ったローディングとエラーの状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)の解説をご覧ください。
- **ウィジェットの外で状態を読む。** バックグラウンド同期、リポジトリ層、または現在の認証トークンを必要とするサービスは、`BuildContext` なしで `ref.read` を呼び出せます。Provider はこれをきれいに行えません。
- **不安定なネットワークプロバイダーに対する回復力が欲しい。** Riverpod 3.0 は、初期化中に失敗するプロバイダーに対して指数バックオフ（200ms から倍々で 6.4s まで）の自動リトライを追加し、ウィジェットが画面外にスクロールしたときにリスナーを自動的に一時停止する機能も加えました。
- **GetX などから移行している。** Riverpod はよくある移行先です。私たちの [GetX から Riverpod への移行ガイド](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)が可動部分を扱っています。

注意点が 1 つあります。Riverpod 3.0 では、`StateProvider`、`StateNotifierProvider`、`ChangeNotifierProvider` が `package:riverpod/legacy.dart` に移動しました。新しいコードは上記の `Notifier` と `AsyncNotifier` クラスを、理想的には `@riverpod` によるコード生成とともに使うべきです。

## Bloc を選ぶべきとき

- **強制された契約を求める大規模チーム。** 5 人の開発者が同じ機能に触れるとき、厳格な `Event -> Bloc -> State` の流れが各自が独自のパターンを発明するのを防ぎます。構造そのものが成果物です。
- **監査可能な状態の履歴が必要。** `BlocObserver` はすべての遷移を見ます。チェックアウト、オンボーディング、複数ステップのフォームのようなフローでは、バグを生んだイベントの正確な順序を再現できることが boilerplate に見合います。
- **複雑で分岐する非同期ロジック。** Bloc のイベントトランスフォーマー（debounce、throttle、`droppable`、`concurrent`）は、重なり合うイベントをどう扱うかを細かく制御できます。これは他の 2 つでは表現が難しいです。
- **単純なケースには `Cubit` が欲しい。** すべての画面に完全なイベントが必要なわけではありません。`Cubit` はイベント層のない Bloc です。新しい状態を直接 `emit` するメソッドを呼ぶので、軽量な Cubit と完全な Bloc を同じアプリで混在させられます。

## Provider を選ぶべきとき

- **すでに持っている。** 動いている Provider のアプリに書き直しは不要です。パフォーマンスが重要でないアプリの状態に対して `ChangeNotifier` を使うことに何も問題はありません。
- **基礎を教えている。** Provider は `InheritedWidget` にほぼ 1 対 1 で対応するため、サードパーティの抽象なしに Flutter がどう状態を伝播するかを誰かに見せるのに最も明快な方法です。
- **本当に小さなアプリ。** スイッチ 1 つの設定画面だけなら、コード生成もイベントパイプラインも正当化できません。

2026 年に Provider がなってはいけないのは、新規で非自明なアプリのデフォルトです。実行時のルックアップモデルは、まさに Riverpod が取り除くために作られた問題です。

## あなたの代わりに決めてくれる落とし穴

いくつかの制約は個人の好みを覆します。

**ウィジェットでないコードから状態を読む。** アーキテクチャにアプリの状態を直接読む必要のあるサービス層やリポジトリ層があるなら、Provider は事実上候補外です。`BuildContext` が必要だからです。Riverpod と Bloc はどちらも純粋な Dart から状態を読めるため、これだけで決着がつくことがよくあります。

**チームの規模とレビュー文化。** ソロのプロジェクトや小さなチームでは、Bloc の儀式は見返りの少ない摩擦であり、Riverpod が速度で勝ちます。コード行数より機能間の一貫性が重要な 15 人のチームでは、Bloc の厳格さはコストではなく機能です。

**不変な状態の規律。** Bloc と現代の Riverpod はどちらも、不変な状態オブジェクトへとあなたを促します。チームが sealed クラスと値の等価性に慣れているなら（モデリングの選択肢については [Dart records vs Freezed クラス](/ja/2026/05/dart-records-vs-freezed-classes/) を参照）、どちらも適合します。可変な `ChangeNotifier` オブジェクトの上に構築された大きなコードベースがあるなら、ある機能が実際にそれ以上を必要とするまで Provider に留まるのが最も安い道かもしれません。

**既存の非同期パターン。** Riverpod の `AsyncValue` は、ローディング、データ、エラーを単一の信頼できる情報源からレンダリングする最も手間のかからない方法です。画面が主に非同期のデータ取得なら、それだけでもこれを選ぶ強い理由になります。

## 推奨、もう一度

2026 年のほとんどの新しい Flutter アプリには、コード生成を伴う Riverpod 3.3.1 を使ってください。コンパイル時の安全性、コンテキスト不要の読み取り、一流の非同期、そして 3.0 の回復力機能が、codegen が Provider に近づける boilerplate のコストで手に入ります。

強制されたイベント駆動の構造と完全に追跡可能な状態の履歴が、チームにとって簡潔さよりも価値があるときは Bloc 9.1.1 を選びましょう。これは大規模チームと複雑なフローでたいてい当てはまります。完全なイベントを必要としない画面には、Bloc アプリの中で Cubit を使ってください。

Provider 6.1.5 はレガシーアプリ、教育、自明な画面のために残しますが、新規で非自明なプロジェクトのデフォルトとして選ばないでください。決め手となる問いはめったに「どれが最も美しいカウンターを持つか」ではなく、「ウィジェットの外で状態を読むか、チームはどれくらいの規模か、非同期はどれくらいあるか」です。この 3 つに答えれば、選択はたいてい自ずと決まります。Flutter を他のスタックと丸ごと比較検討しているなら、私たちの [Flutter vs React Native vs MAUI の比較](/ja/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)が 1 段階引いた視点を与えます。そして何を選んでも、[コントローラーを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)ことを忘れないでください。どの状態管理ライブラリもそれらを代わりに片付けてはくれないからです。

## 参考資料

- [Riverpod: 3.0 の新機能](https://riverpod.dev/docs/whats_new) - レガシー API、自動リトライ、一時停止/再開、オフライン永続化、ミューテーション。
- [pub.dev の flutter_riverpod](https://pub.dev/packages/flutter_riverpod) と [changelog](https://pub.dev/packages/flutter_riverpod/changelog) - バージョン 3.3.1、3.0.0 は 2025-09-10 リリース。
- [pub.dev の flutter_bloc](https://pub.dev/packages/flutter_bloc) - バージョン 9.1.1、BlocProvider / BlocBuilder / BlocListener、Cubit vs Bloc。
- [pub.dev の provider](https://pub.dev/packages/provider) - バージョン 6.1.5、ChangeNotifierProvider、Flutter Favorite。
- [Flutter リリースノート](https://docs.flutter.dev/release/release-notes) - Flutter 3.44 安定版、Dart 3.12。

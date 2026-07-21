---
title: "修正: Riverpod 3.0 で StreamProvider が更新を == でフィルタリングされて発火しなくなる"
description: "Riverpod 3.0 では、すべてのプロバイダーがリスナー通知を同一性ではなく == でフィルタリングします。同じミュータブルオブジェクトを再度発行する StreamProvider は、最初のフレーム以降 UI を再構築しなくなります。なぜそうなるのか、そして 3 つの修正方法を解説します。flutter_riverpod 3.3.2、Flutter 3.44、Dart 3.x で検証済みです。"
pubDate: 2026-07-21
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "streams"
lang: "ja"
translationOf: "2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality"
translatedBy: "claude"
translationDate: 2026-07-21
---

Riverpod 3.0 にアップグレードした後、`StreamProvider` が突然ウィジェットをちょうど 1 回だけ再構築してその後は沈黙してしまう場合、原因は移行ノートにある見落としやすい 1 行です。3.0 では、すべてのプロバイダーがリスナー通知を同一性ではなく `==` でフィルタリングするようになりました。ストリームが同じオブジェクトインスタンスを 2 回発行すると（インプレースで変更するミュータブルなリスト、コントローラー backed のモデルを再度プッシュするなど）、Riverpod は新しい値を前の値と比較し、等しいと判断して通知を破棄します。ストリーム自体はまだ発火しています。Riverpod の外側にある `StreamSubscription` なら、すべてのイベントを引き続き受け取ります。しかし `ref.watch` は決して再構築しません。Riverpod から見れば何も変わっていないからです。修正方法は、毎回新しい非等価な値を発行するか、`updateShouldNotify` をオーバーライドすることです。この記事は `flutter_riverpod` 3.3.2（2026 年 6 月）、Flutter 3.44、Dart 3.x で検証しています。

## 3.0 で実際に変わったこと

3.0 より前の Riverpod は、新しい値がリスナーへの通知に値するかどうかの判断方法が一貫していませんでした。一部のプロバイダー型は `==` で比較し、一部は `identical` を使い、いくつかは独自のロジックを持っていました。`StreamProvider` はその境界線の同一性側にありました。ストリームが生成したイベントはどれもリスナーにプッシュされていました。新しく配信されたストリームイベントは、実質的に新しいものとして扱われていたからです。

Riverpod 3.0 はそのすべてを 1 つのルールに集約しました。[公式の 3.0 移行ガイド](https://riverpod.dev/docs/3.0_migration)より：「すべてのプロバイダーは更新のフィルタリングに `==` を使うようになりました」。ガイドは影響を受けやすいプロバイダーを名指ししています：「この変更で影響を受ける最も可能性が高いケースは `StreamProvider`／`StreamNotifier` を使っている場合です。ストリームの値が `==` でフィルタリングされるようになるためです」。

これは一貫性の観点では良い変更です。前回と等しい値を再計算するプロバイダーが、下流のすべてのウィジェットを無駄に再構築しなくなることを意味します。これは `select` で自分で行おうとする最適化と同じものです。問題は、2.x では全く問題なかったパターン、つまりミュータブルオブジェクトを発行し、それを変更し、再度発行するというパターンに対して、静かな失敗モードを持ち込んでしまうことです。

## 最小限の再現

これが壊れる最小のコードです。リポジトリが `List<int>` を保持し、それに追加し、追加のたびに同じリストを `StreamController` を通じてプッシュします。

```dart
// flutter_riverpod 3.3.2, Dart 3.x
import 'dart:async';

class CounterRepository {
  final _values = <int>[];
  final _controller = StreamController<List<int>>.broadcast();

  Stream<List<int>> get stream => _controller.stream;

  void add(int value) {
    _values.add(value);
    _controller.add(_values); // same List instance every time
  }
}
```

これを `StreamProvider` に接続して監視します：

```dart
// flutter_riverpod 3.3.2
final repositoryProvider = Provider((ref) => CounterRepository());

final valuesProvider = StreamProvider<List<int>>((ref) {
  return ref.watch(repositoryProvider).stream;
});

class ValuesView extends ConsumerWidget {
  const ValuesView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(valuesProvider);
    return async.when(
      data: (values) => Text('Count: ${values.length}'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('Error: $e'),
    );
  }
}
```

2.x ではこれは `add` を呼ぶたびに `Count: 1`、`Count: 2`、`Count: 3` と表示します。3.0 では `Count: 1` を表示した後、二度と更新されません。ウィジェットは最初の発行で固まったままになります。

## データが変わったのになぜここで == が true を返すのか

罠は、`_values` がすべての発行で同じオブジェクトであることです。`_controller.add(_values)` を 2 回目に呼ぶと、ストリームは同一の `List` 参照を配信します。Riverpod は各ストリームイベントを `AsyncData<List<int>>` にラップし、新しい `AsyncValue` が前のものと等しいかどうかを尋ねます。

`AsyncValue` は値の等価性を実装しており、2 つの `AsyncData` インスタンスは、含まれる値が等しいときに等しくなります。あなたのリストの場合、`==` は `List` のデフォルトの等価性にフォールスルーします。それは単なる `List` については参照の等価性です。つまりリストはそれ自身とのみ等しくなります。文字通り同じオブジェクトなので、`previous == next` は `true` です。Riverpod は値が変わっていないと結論づけ、通知を抑制します。発行の間に行った変更は比較からは見えません。比較すべき「前のスナップショット」が存在しないからです。リストは 1 つしかなく、それは常に自分自身と等しいのです。

これが移行ガイドが控えめに書いている部分です。[まさにこの挙動に関する GitHub の issue](https://github.com/rrousselGit/riverpod/issues/4310) は、これを 3 日間のデバッグを費やさせた静かな失敗として説明しています。直接の `stream.listen` コールバックは依然としてすべてのイベントを受け取るため、ストリームは単独では健全に見えますが、プロバイダー層は静かに重複を排除しています。「ストリームは発火している」と「UI は再構築されない」の食い違いこそが、これを非常に見つけにくくしているのです。

## 修正 1: 毎回新しいインスタンスを発行する

最も直接的な修正で、ほぼ常にこれを選ぶべきですが、同じミュータブルオブジェクトを再利用するのをやめることです。イミュータブルなスナップショットを発行し、各イベントが前のものと `==` でない別個の値になるようにします。

```dart
// flutter_riverpod 3.3.2, Dart 3.x
void add(int value) {
  _values.add(value);
  _controller.add(List<int>.unmodifiable(_values)); // fresh instance each emit
}
```

`List<int>.unmodifiable(_values)` は、現在の要素を含む新しいリストを割り当てます。それは前の発行とは別のオブジェクトなので、`previous == next` は `false` となり、Riverpod は通知します。おまけに、ミュータブルなリストをウィジェットツリーに漏らすこともなくなります。これは Riverpod のバージョンに関わらず潜在的なバグでした。どのコンシューマーも、受け取った参照を通じてリポジトリの内部状態を変更できてしまっていたからです。

これは Riverpod 固有のルールではありません。同じミュータブルなコレクションをストリームを通じてプッシュし、それをインプレースで変更することは、値をスナップショット化したり比較したりするどんなコンシューマーに対しても脆弱です。イミュータブルな発行が恒久的な修正です。

## 修正 2: 値の等価性を意図的に使えば、それだけでうまくいく

ときには `==` に内容を比較させ*たい*こともあります。モデルクラスを発行していて、意味のある変化がないときには UI が再構築をスキップしてほしい場合です。その場合は、発行する型に本物の値の等価性を与えれば、3.0 の挙動はバグではなく資産になります。

```dart
// Dart 3.x records give you value equality for free
final positionProvider = StreamProvider<({double lat, double lng})>((ref) {
  return locationStream(); // each event is a new record
});
```

Dart のレコードは構造的に比較するので、同じフィールドを持つ 2 つのレコードは `==` です。つまり、同じ座標を 2 回発行する GPS ストリームは正しく再構築をスキップし、新しい位置を発行するストリームはそれをトリガーします。同じことは、`freezed` から生成された `==`／`hashCode` を持つクラスや、手書きの `operator ==` を持つクラスにも当てはまります。目安としては、値がイミュータブルで値の等価性を持っているなら、3.0 は自動的に正しく動作します。同じ参照を保持することで等価性チェックをミュータブルオブジェクトにすり抜けさせたときにだけ、誤動作します。

## 修正 3: StreamNotifier で updateShouldNotify をオーバーライドする

ストリームが発行するものを本当に変更できない場合（サードパーティのソース、自分が所有していないレガシーなリポジトリ）は、比較をオーバーライドできます。これはクラスベースの API でのみ利用可能なので、関数型の `StreamProvider` を `StreamNotifierProvider` に変換して `updateShouldNotify` をオーバーライドします。

```dart
// flutter_riverpod 3.3.2 with riverpod_annotation 3.x
@riverpod
class Values extends _$Values {
  @override
  Stream<List<int>> build() {
    return ref.watch(repositoryProvider).stream;
  }

  @override
  bool updateShouldNotify(
    AsyncValue<List<int>> previous,
    AsyncValue<List<int>> next,
  ) {
    return true; // always notify, restore the 2.x behavior for this provider
  }
}
```

無条件に `true` を返すことで、アプリの残りの部分についてのグローバルなデフォルトを変えることなく、このプロバイダー 1 つだけについて 3.0 以前の「すべての発行で通知する」挙動を復元します。無条件の再構築が過剰すぎる場合は、たとえば長さやバージョンカウンターを比較するなど、もっと賢くすることもできます。生の関数型 `StreamProvider((ref) => ...)` には `updateShouldNotify` フックがないので、この修正にはクラスベースの形式が必要です。関数型とクラスベースのスタイルのどちらにするかまだ迷っているなら、[Riverpod 2.x から 3.0 への移行](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)ガイドが、それぞれがどんなときに価値があるかを詳しく説明しています。

## これが自分のバグで他の何かではないと確認する方法

症状（ストリームで駆動されるウィジェットが 1 回更新して固まる）にはいくつかの原因が考えられるので、これらの修正に手を伸ばす前に、等価性フィルターが原因であることを確認してください：

1. ストリームソースの中、`_controller.add(...)` の直前に `print` を追加します。すべてのイベントで print されるのにウィジェットが再構築されない場合、イベントはストリームに届いているが下流でフィルタリングされています。
2. 一時的な生のリスナーをアタッチします：`ref.watch(repositoryProvider).stream.listen((v) => debugPrint('raw: $v'))`。生のリスナーが毎回発火するのに `ref.watch(valuesProvider)` が再構築しない場合、プロバイダー層が重複を排除しており、`==` フィルターが確定します。
3. 発行されるオブジェクトが同じインスタンスかどうかを確認します。フィールド、キャッシュされたリスト、シングルトンのモデルをプッシュしているなら、ほぼ間違いなくこれに当たっています。

もし代わりにストリーム自体が発火を止めるなら、それは別の問題です：キャンセルされた `StreamSubscription`、クローズされたコントローラー、破棄されて再作成されたプロバイダーです。ストリームのライフサイクルの破棄側については、[dispose での StreamSubscription のキャンセル](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)を参照してください。

## 同じ 3.0 リリースにある関連する落とし穴

等価性フィルターは、コンパイル時ではなく実行時に表面化する 3.0 変更のひとかたまりのうちの 1 つで、それがデバッグを高くつくものにしています。出荷前に知っておく価値のある他の 2 つ：

- **エラーはラップされて出てくるようになりました。** スローするプロバイダーは、元の例外を直接再スローしなくなりました。アンラップの方法については[Riverpod 3.0 が元のエラーの代わりに ProviderException をスローする](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)を参照してください。
- **失敗したプロバイダーは自動的にリトライします。** エラーになった `FutureProvider` や `StreamProvider` は、デフォルトで指数バックオフでリトライします。これはバグを覆い隠したり、失敗しているエンドポイントを叩き続けたりする可能性があります。[Riverpod 3.0 の自動プロバイダーリトライを無効化する](/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/)で説明されているように、プロバイダーごとまたはグローバルにオフにしてください。

そして、notifier 内の非同期のギャップが `await` の後に `ref` に触れる場合は、[非同期ギャップの後の Ref.mounted のチェック](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)で扱っている mounted チェックでガードしてください。

## 覚えておくべき 1 行のルール

Riverpod 3.0 は `previous != next` のときに再構築します。`StreamProvider` がミュータブルオブジェクトを再利用すると、`previous` と `next` は同じ参照になり、常に等しいので決して再構築しません。イミュータブルなスナップショットを発行する（または値の型に本物の等価性を与える）ことで、フレームワークは正しく動作します。`updateShouldNotify` に手を伸ばすのは、発行される値を制御できないときだけにしてください。そもそも `StreamProvider` とその `AsyncValue` が、古いビルダーウィジェットに対して正しいツールなのかどうかについて、より広い視点で見たいなら、[FutureBuilder と StreamBuilder を Riverpod の AsyncValue と比較する](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)が次に読むのに良い記事です。

## 参考資料

- [2.0 から 3.0 への移行、Riverpod 公式ドキュメント](https://riverpod.dev/docs/3.0_migration)
- [Riverpod 3.0 の新機能](https://riverpod.dev/docs/whats_new)
- [rrousselGit/riverpod issue #4310: updateShouldNotify の変更が移行ガイドで軽視されている](https://github.com/rrousselGit/riverpod/issues/4310)
- [StreamProvider クラスリファレンス、flutter_riverpod](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/StreamProvider-class.html)

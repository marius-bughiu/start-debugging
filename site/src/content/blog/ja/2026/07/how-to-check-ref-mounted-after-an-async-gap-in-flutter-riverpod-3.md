---
title: "Flutter Riverpod 3 で非同期ギャップの後に Ref.mounted を確認する方法"
description: "Notifier では await の前に依存関係を解決し、その後 if (!ref.mounted) return で state の書き込みを保護します。これは Riverpod 3.0 における古い onDispose ミックスインの代替であり、provider が await の途中で破棄されたときの UnmountedRefException を防ぎます。flutter_riverpod 3.x、Flutter 3.44、Dart 3.x で検証済みです。"
pubDate: 2026-07-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "ja"
translationOf: "2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3"
translatedBy: "claude"
translationDate: 2026-07-04
---

ルールは短いです。`Notifier` や `AsyncNotifier` の中では、`await` によってコードが再開する前に provider が破棄されることがあり、破棄された provider に `state` を書き込むと例外がスローされます。ですから、最初の `await` の前に `ref` から必要なものをすべて読み取り、非同期処理を行い、その後 `if (!ref.mounted) return;` で `state` の書き込みを保護してください。`Ref.mounted` は Riverpod 3.0 のプロパティで、`BuildContext.mounted` の provider 側の双子であり、非同期ギャップの後に「この provider はまだ生きているか」を尋ねるためのサポートされた方法です。このガイドは `flutter_riverpod` 3.x（3.0 系は 2025 年 9 月にリリース、現行版は 3.3.2）、Flutter 3.44（安定版、2026 年 5 月）、Dart 3.x で検証しています。

await の後に確認できるように `ref.onDispose` でブール値を切り替える独自のミックスインを書いたことがあるなら、今はそれを削除できます。`Ref.mounted` はまさにそれを、正しく、定型コードなしで行います。

## なぜ await が provider を破棄したまま残すのか

provider の `Ref` はその provider のライフタイムに束縛されています。provider が破棄されると、その `Ref` は無効になり、Riverpod 3.0 はそれとのその後のあらゆる操作、つまり `ref` の読み取り、`ref.read` の呼び出し、`state` の代入で例外をスローします。得られる例外は `UnmountedRefException` です。「notifier がすでに unmounted の場合、非同期ギャップの後に `ref` や `state` を使うと例外がスローされる」というものです。

これがとりわけ `await` の後で噛みつく理由は、非同期ギャップにあります。`Future` で中断している間に provider を破棄しうるものが 3 つあります。

`autoDispose` の provider が最後のリスナーを失う場合。provider を監視しているウィジェットが await 中にスタックから取り除かれると、provider にはもう誰も listen していないため、Riverpod はそれを破棄します。すると継続は死んだ `Ref` を保持したまま目覚めます。

provider が明示的に無効化される場合。アプリの別の部分がギャップ中に `ref.invalidate(myProvider)` または `ref.refresh(myProvider)` を呼び出すと、現在のインスタンスが解体され、新しいものが構築されます。中断中のメソッドが保持している古いインスタンスの `Ref` は、いまや破棄されています。

依存関係が変化する場合。provider が変化した何かを `watch` していると再ビルドが強制されます。前回のビルドの `Ref` は退役します。

Riverpod 3.0 は、リスナーを即座に切り離す代わりに再ビルドをまたいで一時停止させることで、最初のケースをより稀にしました。そのため、単に再ビルドされるだけの provider は積極的には破棄されません。しかし、await の途中ですべての監視者を失う、本当に孤立した `autoDispose` の provider は依然として破棄されます。このライフサイクル変更は誤検知を減らしましたが、本物を取り除いたわけではありません。これはまさに [riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) で追跡されているシナリオです。

重要なメンタルモデルは、このクラッシュがタイミング依存だということです。待機する処理が速いとき、provider は再開時にたいてい生きていて、すべてが動作します。ネットワークが遅い、あるいはユーザーの操作が速いとき、provider が先に破棄され、`state` の書き込みが失敗します。だからこそこのバグはコードレビューを通過し、あなたのマシンでは通り、本番環境でクラッシュするのです。

## 最小の再現

この `AsyncNotifier` はリストを取得し、await の後にそれを `state` へ書き戻します。コンパイルされ、実行され、取得が速いときは毎回成功します。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- throws UnmountedRefException.
import 'package:flutter_riverpod/flutter_riverpod.dart';

final ordersProvider =
    AsyncNotifierProvider.autoDispose<OrdersNotifier, List<Order>>(
  OrdersNotifier.new,
);

class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    state = const AsyncLoading();
    // ~800ms round trip. If the screen that watches ordersProvider is popped
    // during this await, the autoDispose provider loses its last listener and
    // is disposed. The line below then runs on a dead Ref.
    final orders = await ref.read(orderRepositoryProvider).fetch();
    state = AsyncData(orders); // throws UnmountedRefException
  }
}
```

`refresh()` を起動し、800 ミリ秒以内に画面をスタックから取り除くと、`state = AsyncData(orders)` の行が例外をスローします。取得に問題はありません。問題は、`refresh` が `Future` の完了時に provider がまだ存在していると仮定したことであり、監視者が去った `autoDispose` の provider にとって、それは存在しないのです。

## 修正の手順

2 つのルールでほぼすべてのケースをカバーできます。ギャップの前に依存関係を解決し、その後に state の書き込みを保護します。

1. **必要な依存関係をすべて最初の `await` の前に読み取ります。** provider が生きていることが保証されている間（メソッドの同期部分）に、使用するサービス、リポジトリ、notifier ごとに `ref.read` を呼び出し、結果をローカル変数に保存します。プレーンなオブジェクトへの参照は provider が破棄されても古くなりません。古くなるのは `Ref` だけです。

2. **非同期処理を行います。** キャプチャしたローカル変数を使って `Future` を await します。避けられるなら、await される式の中で `ref` に触れないでください。

3. **再開を `ref.mounted` で保護します。** `state` を代入する（あるいは任意の `ref` メソッドを呼び出す）直前に、`if (!ref.mounted) return;` を確認します。provider がギャップ中に破棄されていた場合、例外をスローする代わりにきれいに抜け出します。

4. **`state` を代入します。** これで書き込みは生きている provider に着地します。

修正後の notifier は次のとおりです。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- correct.
class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    final repo = ref.read(orderRepositoryProvider); // 1. read deps first
    state = const AsyncLoading();

    final next = await AsyncValue.guard(repo.fetch); // 2. async work

    if (!ref.mounted) return; // 3. the provider may be gone
    state = next;             // 4. safe write
  }
}
```

`repo` は永続的なオブジェクトハンドルです。provider が死んでいても、await の後で問題なく機能します。クラッシュを止めるのは `ref.mounted` の確認です。provider が破棄されると `false` を返すため、`state` の代入が無効な `Ref` に対して実行されることはありません。これは [AsyncValue によるロードとエラーの状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) を安全に保つのと同じ規律であり、ウィジェット側の [await 後の BuildContext 保護](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) と構造的に同一です。

Riverpod 3.0 の公式ドキュメントは、まさにこのパターンを示しています。

```dart
// From the Riverpod 3.0 "what's new" docs.
Future<void> addTodo(String title) async {
  final newTodo = await api.addTodo(title);
  if (!ref.mounted) return;
  state = [...state, newTodo];
}
```

## ref.mounted、WidgetRef、context.mounted：どの確認をどこに

最も一般的な混乱の元は、どの `mounted` が必要かということです。なぜなら 3 つあり、それぞれ異なるオブジェクトに存在するからです。

`ref.mounted` は provider の `Ref` にあり、`Notifier`、`AsyncNotifier`、あるいは関数型 provider の本体（`Ref ref`）の中で得られるものです。非同期コードが provider に存在するときに使います。これは Riverpod 3.0 が追加したプロパティで、2.x には存在しませんでした。

`context.mounted` は `BuildContext` にあります。非同期コードがウィジェットに存在し、その後にツリー（`Navigator`、`ScaffoldMessenger`、`Theme.of`）に触れる必要があるときに使います。Dart アナライザーの `use_build_context_synchronously` リントがこれを強制します。

`State.mounted` は `State`（したがって `ConsumerState`）にあります。`ConsumerStatefulWidget` で `setState` を呼び出す前、あるいは await の後に `WidgetRef` を読む前に使います。落とし穴に注意してください。ウィジェット内の `WidgetRef` は provider の `Ref` と同じオブジェクトではなく、`ref.mounted` を持ちません。ウィジェットでは `ref.mounted` ではなく `context.mounted` または `State.mounted` で保護します。

経験則としては、例外をスローするスタックフレームが `Notifier` や `AsyncNotifier` の中にあるなら `ref.mounted` が必要です。`ConsumerState` や `ConsumerWidget`（build／コールバック）の中にあるなら `context.mounted` または `State.mounted` が必要です。これを間違えることが、密接に関連する [Cannot use "ref" after the widget was disposed クラッシュ](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) の根本原因であり、その provider 側のバリアントに対する先回りの答えがこのガイドです。

## いま削除できる 2.x のミックスイン

Riverpod 3.0 より前には `Ref.mounted` がなかったため、コミュニティの回避策は破棄を手動で追跡するミックスインでした。

```dart
// Riverpod 2.x workaround -- no longer needed on 3.0.
mixin NotifierMounted {
  bool _mounted = true;
  void setUnmounted() => _mounted = false;
  bool get mounted => _mounted;
}

class SomeNotifier extends AutoDisposeAsyncNotifier<void>
    with NotifierMounted {
  @override
  FutureOr<void> build() {
    ref.onDispose(setUnmounted); // flip the flag when disposed
  }

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (mounted) {
      state = next;
    }
  }
}
```

これは動作しましたが、Riverpod のメンテナーは明確に推奨しておらず、鋭い角がありました（`onDispose` の登録を忘れないようにする必要があり、フラグが ref ではなく notifier のインスタンスに存在していました）。3.0 では、ミックスイン全体が 1 つのプロパティに収束します。

```dart
// Riverpod 3.x -- the mixin is gone, ref.mounted is built in.
class SomeNotifier extends AutoDisposeAsyncNotifier<void> {
  @override
  FutureOr<void> build() {}

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (!ref.mounted) return;
    state = next;
  }
}
```

2.x からアップグレードしていて、コードベースに `NotifierMounted` ミックスイン（あるいは手作りの `_mounted` フラグ）が見えるなら、それはいまや不要な重荷です。ミックスインを削除し、`ref.onDispose(setUnmounted)` の行を削除し、`if (mounted)` を `if (!ref.mounted) return;` に置き換えてください。

## 落とし穴とエッジケース

**`ref.mounted` は `ref.onDispose` によるクリーンアップの代わりにはなりません。** 保護は破棄された provider への書き込みを防ぎますが、リソースをクリーンアップはしません。provider がサブスクリプション、ソケット、タイマーを所有しているなら、`build` の中で `ref.onDispose` を使ってその解体を登録してください。そして `onDispose` コールバックの中で `ref.read` を呼び出さないでください。その時点で provider はすでに破棄されつつあるため、`ref` は無効であり、再び `UnmountedRefException` に突き当たります。DCM のリント `avoid-ref-inside-state-dispose` がまさにこれを指摘します。

**`autoDispose` の provider を `.future` 経由で読むと、最初の await の後に破棄されることがあります。** [riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293) で議論されている微妙なケースがあり、`.future` 経由で読まれた `autoDispose` の provider は、読み取りが作成した一時的なリスナーが解放されるため、最初の `await` の後に破棄されます。await をまたいで読み取りを連鎖させている場合は、`.future` が provider を開いたままにすると仮定するのではなく、本物のリスナーを生かしておいてください（watch するか、`ref.keepAlive()` を使います）。

**`ref.keepAlive()` は計算を変えます。** `ref.keepAlive()` でピン留めした provider は、最後のウィジェットが去っても `autoDispose` しないため、「最後のリスナーを失った」原因は消えます。それでも明示的な `invalidate` や `refresh` によって破棄されうるので `ref.mounted` の保護は残してください。ただし、ピン留めは最も一般的なトリガーを取り除くことを理解してください。

**`AsyncValue.guard` はマウントを保護しません。** `AsyncValue.guard` はスローされた例外を `AsyncError` に変換し、クラッシュする代わりにエラーを状態に着地させます。破棄については何もしません。保護された結果を `state` に代入する前に、その後で依然として `if (!ref.mounted) return;` が必要です。2 つの仕組みは別々の問題を解決します。`guard` は Future の失敗を扱い、`ref.mounted` は provider の消失を扱います。

**`ConsumerWidget` には `ref.mounted` がありません。** その `ref` は `WidgetRef` であり、provider の `Ref` ではありません。ステートレスな `ConsumerWidget` の中で非同期コールバックに `WidgetRef` をキャプチャした場合、確認すべき `mounted` はありません。非同期処理を Notifier に移し、永続的な provider の `Ref` の背後で実行されるようにするか（これは [FutureBuilder から AsyncNotifier への移行](/ja/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) が生み出す形です）、`ConsumerStatefulWidget` に切り替えて `State.mounted` を持つようにしてください。

**3.0 へのアップグレード後にのみスローし始めた場合。** Riverpod 3.0 は、2.x が時に黙って許容していた破棄後の操作で例外をスローします。以前「動作していた」コードは、すでに破棄された provider に書き込んでいたのです。3.0 は潜在的なバグを作り出したのではなく、表面化させました。保護を追加してください。それを隠すために 2.x に戻さないでください。

## 見逃したものはリンターに捕まえさせる

保護は習慣であり、習慣はすり抜けます。2 つの静的解析ルールが「`ref.mounted` の確認を忘れないこと」をコンパイルエラーに変えます。DCM は `use-ref-and-state-synchronously` を提供しており、mounted の確認が先行しない非同期ギャップ後の `ref` または `state` へのアクセスを指摘します。また `onDispose` のケースには `avoid-ref-inside-state-dispose` があります。Riverpod 独自のリントセットにも同等のものが含まれます。標準では、Dart コンパイラーは `BuildContext` に対して行うようには await 後の `ref` について警告しません。ですからこれらのルールを有効にすることが、バグを CI で捕まえるか、クラッシュレポートで捕まえるかの違いになります。

このクラス全体のバグを取り除く唯一の規律は、provider の `Ref` を `BuildContext` とまったく同じように扱うことです。同期的には有効で、`await` がそれを無効にしうるので、ギャップの前に必要なものを読み取り、await 後のすべての `ref` または `state` への操作を `if (!ref.mounted) return;` で保護してください。これを async-notifier の反射に組み込めば、`UnmountedRefException` は現れなくなります。それが [Riverpod の Notifier 所有のライフサイクルが 2026 年の state management のデフォルトの選択肢である](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) 理由の 1 つです。

## 関連記事

- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)：この保護を省いたときに得られるクラッシュを扱う、反応側の対応記事です。ウィジェット側と provider 側の両方を扱います。
- [Flutter で await の後に BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)：ウィジェット側の `context.mounted` に対する同じ保護です。
- [Flutter Riverpod で AsyncValue によるロードとエラーの状態を表示する方法](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)：この保護が守る `AsyncNotifier` と `AsyncValue.guard` のパターンを示します。
- [Flutter で FutureBuilder から Riverpod の AsyncNotifier に移行する](/ja/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)：非同期処理を `ref.mounted` が利用できる provider に移します。
- [2026 年の Flutter の state management における Provider vs Riverpod vs Bloc](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)：なぜ Notifier 所有のライフサイクルが現代のデフォルトなのかを扱います。

## 出典

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)：`Ref.mounted`、`if (!ref.mounted) return;` のパターン、再ビルド時にリスナーを一時停止するライフサイクル変更を導入しています。
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq)：provider の `Ref` と `WidgetRef` のライフタイムについて。
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096)：非同期ギャップの後に notifier で `ref` を使うことと、3.0 の修正について。
- [rrousselGit/riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293)：`.future` 経由で読んだときに `autoDispose` の provider が最初の `await` の後に破棄される理由。
- [DCM use-ref-and-state-synchronously rule](https://dcm.dev/docs/rules/riverpod/use-ref-and-state-synchronously/)：非同期ギャップの後に mounted の確認を強制するリント。
- [How to Check if an AsyncNotifier is Mounted with Riverpod, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/)：古い 2.x のミックスインと 3.0 の `ref.mounted` による代替。
</content>

---
title: "解決: Flutter Riverpod で Bad state: Cannot use \"ref\" after the widget was disposed"
description: "このクラッシュは、ウィジェットがツリーを離れた後に WidgetRef を使用したことを意味します。多くは非同期コールバックで起きます。必要なものを await の前に読み取り、mounted チェックで保護してください。"
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ja"
translationOf: "2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-14
---

あなたのコードは、所有するウィジェットが破棄された後に Riverpod の `WidgetRef` にアクセスしました。よくある原因は、ユーザーが画面を離れた後に完了する非同期コールバック（`await`、`Future.then`、`Timer`、stream のリスナー）が、その後で `ref.read`、`ref.watch`、`ref.listen` を呼び出すことです。修正方法は、`ref` から必要なものをすべて `await` の前に読み取り、その後の処理を `if (!mounted) return;` チェックで保護することです。このガイドでは Flutter 3.44（安定版、2026 年 5 月）、Dart 3.x、Riverpod 3.0（2025 年 9 月リリース）を使用します。

`WidgetRef` は、その取得元のウィジェットの寿命に紐づいています。そのウィジェットがツリーから削除された瞬間に ref は無効になり、それ以降の使用はすべて例外をスローします。これは設計上の仕様です。破棄されたウィジェットが providers を読み書きする理由はなく、Riverpod は、ユーザーがすでに離れた画面へ状態を黙って漏らすよりも、大きな音を立てて失敗することを選びます。

## エラーの全体像

Riverpod がスローする完全なメッセージは次のようになります。

```
Unhandled Exception: Bad state: Cannot use "ref" after the widget was disposed.
#0      ProviderElementBase._assertNotDisposed (package:flutter_riverpod/...)
#1      ConsumerStatefulElement.read (package:flutter_riverpod/src/consumer.dart)
#2      _CheckoutScreenState._submit.<anonymous closure> (package:my_app/checkout_screen.dart:42)
...
```

あなた自身のコード内のフレームは、死んだ ref にアクセスした行を示します。`ref.read(...)`、`ref.watch(...)`、`ref.listen(...)` の呼び出しです。そのフレームは例外が表面化する場所ですが、発生した理由は時間的にもっと前、つまりその行が実行される前にウィジェットが破棄されたときにあります。

非常に近い別バリアントが、わずかに異なる名詞で存在します。

```
Bad state: Cannot use "ref" after the provider was disposed.
```

こちらは、ウィジェット内の `WidgetRef` ではなく、`Notifier` または `AsyncNotifier` 内の `Ref` から来ます。同じファミリー、同じ根本原因、異なる所有者です。ウィジェット版は "widget" と言い、provider 版は "provider" と言います。修正は少し異なり、下の Notifier に関するセクションで扱います。

## なぜ起こるのか

原因は 4 つあり、おおよそ発生頻度の順に並べます。

ウィジェットより長く生き残った非同期コールバックで `WidgetRef` がキャプチャされた。画面が生きている間に `await`、`Future.then`、`Timer`、`stream.listen` を開始し、ユーザーがルートを閉じ（これにより `ConsumerState` が破棄され、その `ref` が無効になります）、その後コールバックが完了して `ref.read` を呼び出しました。これが圧倒的に多い原因です。タイミングが揃ったときだけクラッシュするためで、待機する処理が速いときは毎回通り、ネットワークが遅いときやユーザーが素早いときにクラッシュします。

`dispose()` の中で `ref` を使った。クリーンアップ（サブスクリプションの解除、バッファのフラッシュ、provider への通知）のために `ref.read` を呼ぶ `ConsumerState.dispose()` はこのエラーに陥ります。`dispose` が実行される時点で `WidgetRef` はすでに分解されているためです。Riverpod チームはこの形をまさに [issue 4142](https://github.com/rrousselGit/riverpod/issues/4142) で追跡しています。ウィジェットはまだマウントされているように見えますが、エレメントの ref は消えています。クリーンアップは、ウィジェットの `dispose` ではなく、provider 自身の `ref.onDispose` を通して行う必要があります。

`WidgetRef` を長命なオブジェクトに保存した。`build` で受け取った `ref` を保持するコントローラー、サービス、または「ロジック」クラスは、古い参照を保持し続けます。ウィジェットが再ビルドされたり離れたりすると、その保存された ref は破棄されたエレメントを指します。`WidgetRef` は永続的なハンドルではありません。それを所有するウィジェットのインスタンスに対してのみ有効です。

Notifier 内の非同期ギャップをまたいで provider が破棄された。`autoDispose` の Notifier で何かを `await` すると、provider はギャップの間に最後のリスナーを失い（または無効化され）、Riverpod はそれを破棄し、`await` の後の行が `ref` を読み取ります。これが "after the provider was disposed" バリアントです。Riverpod 3.0 は、再ビルド時にリスナーを即座に削除する代わりに一時停止することで、これを稀にしましたが、await の途中で実際にすべてのウォッチャーを失う `autoDispose` provider はやはり破棄されます。このトピックは [riverpod の issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) で議論されています。

根底にある契約は、Riverpod 3.0 のリリースノートにあります。"Refs and Notifiers can no longer be interacted with after they have been disposed"。Riverpod 3.0 は、破棄後の操作を許容するのではなく、いかなる操作でも例外をスローします。そのため、2.x で黙って失敗していたコードが、いまは大きな音を立ててクラッシュします。これはフレームワークが仕事をしているということです。

## 最小限の再現

この画面は、送信が完了する前に離れるとクラッシュします。コンパイルして実行でき、ネットワークが速いときは毎回通ります。

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- throws "Cannot use \"ref\" after the widget was disposed".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final cartProvider = NotifierProvider<CartNotifier, int>(CartNotifier.new);

class CartNotifier extends Notifier<int> {
  @override
  int build() => 3;
  void clear() => state = 0;
}

class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key});

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  Future<void> _submit() async {
    // Pretend this posts the order and takes ~800ms.
    await Future.delayed(const Duration(milliseconds: 800));
    // If the user popped this screen during those 800ms, the ConsumerState and
    // its WidgetRef are already disposed. This line then throws.
    ref.read(cartProvider.notifier).clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: _submit,
          child: const Text('Place order'),
        ),
      ),
    );
  }
}
```

"Place order" をタップし、800 ミリ秒以内に画面を閉じてください。`ConsumerState` が破棄され、その `ref` が無効になり、`Future` が完了し、`ref.read(cartProvider.notifier)` が例外をスローします。このクラッシュはタイミング依存であり、まさにそのためにコードレビューを生き延びてリリースされます。

## 修正の詳細

修正はおすすめ度の高い順に並べています。あなたの原因に合うものを選んでください。

### 1. await の前に読み取り、残りを mounted で保護する（推奨）

2 つのルールでウィジェット側のほぼすべての発生を網羅できます。第一に、ウィジェットが確実に生きている間に、`ref` から必要なものをすべて `await` の前に解決します。第二に、`await` の後では、ツリーに触れる、`setState` を呼ぶ、あるいは次の `ref` 呼び出しを行う前に `mounted` をチェックします。

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- correct.
Future<void> _submit() async {
  // Resolve the notifier BEFORE the await, while ref is still valid.
  final cart = ref.read(cartProvider.notifier);

  await Future.delayed(const Duration(milliseconds: 800)); // post the order

  if (!mounted) return; // the ConsumerState (and its WidgetRef) may be gone
  cart.clear();
}
```

`cart` は notifier への通常のオブジェクト参照です。ウィジェットが破棄されても古くならないため、await の後に `cart.clear()` を呼んでも安全です。`mounted` チェックは、死んだウィジェット上で UI（`setState`、`Navigator.push`、`ScaffoldMessenger` の呼び出し）を駆動することも防ぎます。ここでの `mounted` は標準の `State.mounted` であり、`ConsumerState` は他の `State` と同様にそれを公開します。

このルールは、コントローラーの破棄クラッシュを修正するものと同じです。`State` メソッド内の各 `await` の後、`this`、`ref`、ツリーに触れる次の行の前には `mounted` チェックが必要です。Dart アナライザーの `use_build_context_synchronously` lint は、この間違いの `BuildContext` 版を捕捉します。`ref` もまったく同じように扱ってください。同じ規律は、[破棄後に使用された TextEditingController の修正](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)にも現れます。これはオブジェクトが違うだけの同じクラスのバグだからです。

### 2. Notifier では非同期ギャップの後に ref.mounted をチェックする

クラッシュが "after the provider was disposed" バリアントなら、あなたはウィジェットではなく `Notifier` または `AsyncNotifier` の中にいます。Riverpod 3.0 は `Ref.mounted` を追加しました。`BuildContext.mounted` の provider 側に相当するものです。依存関係を await の前に読み取り、その後で状態の書き込みを `ref.mounted` に条件付けます。

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0
class OrdersNotifier extends AsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => _repo().fetch();

  OrderRepository _repo() => ref.read(orderRepositoryProvider);

  Future<void> refresh() async {
    final repo = _repo(); // read deps before the gap
    final next = await AsyncValue.guard(repo.fetch);

    if (!ref.mounted) return; // the provider may have been disposed mid-fetch
    state = next;
  }
}
```

Riverpod 3.0 より前には `ref.mounted` がなく、一般的な回避策は `ref.onDispose` でフラグを切り替える小さな mixin でした。3.0 ではその mixin を削除できます。`ref.mounted` がサポートされたチェックです。破棄された notifier に `state` を設定することが例外をスローするので、ガードは代入の直前に置きます。これは、[AsyncValue でのローディングとエラーの状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)を非同期ギャップをまたいで安全に保つのと同じ形です。

### 3. WidgetRef をロジッククラスに保存しない

クラッシュが非同期でないなら、多くは保存された ref です。`WidgetRef` は 1 つのウィジェットに属し、それとともに死ぬため、それを保持するコントローラーやサービスは、いずれ死体を逆参照することになります。ロジックを Notifier に移し、provider の常に生きている `Ref` を使わせてください。

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- the logic owns a durable Ref, not a WidgetRef.
final sessionProvider = NotifierProvider<SessionNotifier, Session?>(SessionNotifier.new);

class SessionNotifier extends Notifier<Session?> {
  @override
  Session? build() => null;

  Future<void> signOut() async {
    await ref.read(authProvider).signOut(); // ref here is the provider's Ref
    if (!ref.mounted) return;
    state = null;
  }
}
```

ウィジェットはイベントハンドラーから `ref.read(sessionProvider.notifier).signOut()` を呼び出し、長時間の処理は、provider が使われている限り Riverpod が生かし続ける `Ref` の背後で動きます。ウィジェットが自分自身の `ref` より長く生きる必要はありません。ライフサイクルの所有権をウィジェットの外、Notifiers の中へ移すことは、まさに [GetX から Riverpod への移行](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)が築かれている形であり、[2026 年に Riverpod が状態管理のデフォルトの選択である](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)理由の 1 つでもあります。

### 4. ウィジェットの dispose() の中では決して ref を使わない

provider を必要とするクリーンアップは `ConsumerState.dispose()` には属しません。その時点で `WidgetRef` はすでに無効だからです。それには 2 つの正しい置き場所があります。リソースが provider に所有されている場合は、その provider 内で `ref.onDispose` にクリーンアップを登録します。これは provider が破棄されるときに実行されます。

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- cleanup lives with the provider, not the widget.
final socketProvider = NotifierProvider<SocketNotifier, void>(SocketNotifier.new);

class SocketNotifier extends Notifier<void> {
  late final WebSocketChannel _channel;

  @override
  void build() {
    _channel = WebSocketChannel.connect(Uri.parse('wss://example.com'));
    ref.onDispose(_channel.sink.close); // runs when the provider goes away
  }
}
```

ウィジェットの破棄時に本当に何かをする必要がある場合は、通常のオブジェクト（notifier、サブスクリプション、値）を `initState` または `didChangeDependencies` でキャプチャしてフィールドに保存し、`dispose()` ではそのフィールドを使ってください。`dispose` 自体から `ref.read` を呼び出してはいけません。

## 落とし穴とバリアント

`Cannot use "ref" after the provider was disposed`。このエラーの Notifier 側の双子で、上の修正 2 でカバーされます。スタックフレームが `ConsumerState` ではなく `Notifier`/`AsyncNotifier` の中にあるなら、`State.mounted` ではなく `ref.mounted` が必要です。2 つのメッセージは 1 語だけ異なり、その語がどちらのチェックを使うかを教えてくれます。

`onPressed` の `ref.read` は動くが、同じハンドラー内の `await` の後の `ref.read` は動かない。イベントハンドラーの同期部分はウィジェットが生きている間に実行されるので、`onPressed` の先頭にある素の `ref.read` は問題ありません。破棄されたウィジェットに着地し得るのは、`await` の後のコードだけです。分岐線はハンドラーではなく、最初の `await` です。

クラッシュが時々しか起きない。これは非同期原因のシグネチャであり、不安定なフレームワークのものではありません。速いバックエンドはそれを隠し、遅いバックエンドや素早いユーザーはそれを露出させます。上の再現が行っているように、`ref` 呼び出しの前に人工的な `Future.delayed` を追加し、遅延中に画面を閉じることで、決定論的に再現してください。

Riverpod 3.0 へのアップグレード後に始まった。Riverpod 3.0 は、2.x が時々許容していた破棄後の操作に対して例外をスローします。以前「動いていた」コードはすでに破棄された ref に触れていました。3.0 は新たなバグを導入したのではなく、潜在的なバグを表面化させたのです。リリースノートは、refs と notifiers が破棄後にもう使用できないことを明確に述べています。アクセスを修正してください。それを隠すために 2.x に固定し直さないでください。

`ConsumerWidget`（ステートレス）でこれが起きる。`ConsumerWidget` には `State` がないため、`mounted` がありません。その `ref` をウィジェットより長く生きるコールバックでキャプチャするなら、保護のための `mounted` フラグを持てるよう `ConsumerStatefulWidget` に移すか、非同期処理を Notifier に押し込んで（修正 3）、ウィジェットが自分の寿命を超えて ref を保持しないようにしてください。

`use_build_context_synchronously` は `ref` をフラグしない。await の後に使われた `BuildContext` を捕捉するアナライザー lint には、`WidgetRef` のための組み込みの同等物がありません。DCM や Riverpod 3.0 の lint セットのような静的アナライザーはそのためのルール（ref と state を同期的に使用する）を追加し、有効にする価値がありますが、デフォルトではコンパイラーは警告しません。`context` を扱うのと同じように、`await` の後のすべての `ref` を疑わしいものとして扱ってください。

このバグのクラス全体を取り除く唯一の規律はこうです。`WidgetRef` は、それを所有するウィジェットの同期ボディの中でのみ有効なので、必要なものはどの `await` よりも前に読み取り、その後のすべてを `mounted`（ウィジェット）または `ref.mounted`（Notifier）で保護し、永続的なロジックは、来ては去るウィジェットではなく providers に保ちます。これを非同期ハンドラーの反射として身につければ、エラーは現れなくなります。それは [build 中に呼ばれた setState または markNeedsBuild のエラー](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)を修正するのと同じ `mounted` ガードの反射であり、それを引き起こす遅い応答タイミングは通常、[アプリがネットワークエラーをどう扱うか](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/)に行き着きます。

## 関連記事

- [解決: Flutter で A TextEditingController was used after being disposed](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) は、コントローラー向けの同じ破棄後クラッシュで、同じ mounted ガードの修正を使います。
- [Flutter Riverpod で AsyncValue を使ってローディングとエラーの状態を表示する方法](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) は、非同期の結果を Notifier の状態に保ち、危険な await 後のパスから外します。
- [解決: Flutter で setState() or markNeedsBuild() called during build](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) は、非同期コールバックのための mounted ガードの規律を共有します。
- [Flutter アプリを GetX から Riverpod へ移行する方法](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) は、永続的な Ref を所有する Notifiers へロジックを移す方法を示します。
- [2026 年の Flutter 状態管理における Provider vs Riverpod vs Bloc](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) は、Notifier が所有するライフサイクルがなぜ現代のデフォルトなのかを扱います。

## 出典

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- `Ref.mounted` と "refs and notifiers can no longer be interacted with after they have been disposed" のルールを導入します。
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- `WidgetRef` と provider の `Ref` の寿命の違いについて。
- [rrousselGit/riverpod issue 4142](https://github.com/rrousselGit/riverpod/issues/4142) -- ウィジェットの `dispose` コールバックで `ref` を使ったときにスローされるエラー。
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- 非同期ギャップの後に Notifier で `ref` を使うことと、3.0 のリスナー一時停止による修正。
- [AsyncNotifier がマウントされているか確認する、codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- Riverpod 3.0 の `ref.mounted` パターンと 2.x のレガシー mixin。

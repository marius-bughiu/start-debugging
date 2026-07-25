---
title: "Flutter で setState の StatefulWidget を Riverpod の Notifier に移行する"
description: "ウィジェットローカルな setState から Riverpod 3.x の Notifier へ移す手順です。何をウィジェットの外に出すかを仕分けし、Notifier を書き、ConsumerWidget に変換し、setState からの移行者を悩ませる == によるフィルタリング、build() の再実行、autoDispose の既定値の違いを乗り切ります。Flutter 3.44、Dart 3.x、flutter_riverpod 3.3.2 で検証しました。"
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ja"
translationOf: "2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-25
---

画面 1 つを `setState` から Riverpod の `Notifier` へ移す作業は、2 回もやれば 1 時間ほどで終わります。そしてその 1 時間の大半は、何を移さないかを決める時間です。本記事は Flutter 3.44 (安定版、2026 年 5 月)、Dart 3.x、`flutter_riverpod` 3.3.2 で検証しており、コード生成を使う場合は `riverpod_generator` 4.0.4 と `riverpod_annotation` 4.0.3 を前提とします。壊れるのはコンパイラであることはまれで、実際に噛みついてくるのは次の 3 点です。Riverpod 3.0 が通知を `==` でフィルタリングすること (`setState` では見逃されていたリストのその場変更が、今度は何も言わずに UI を再構築しなくなります)、`initState` が 1 回しか走らなかった場所で `Notifier.build()` が再実行されること、そして自動破棄の既定値が生成されたプロバイダーと手書きのプロバイダーで異なることです。2 つのウィジェットが同じ状態を必要とするとき、あるいはウィジェットを介さずにロジックをテストしたいときに実施してください。真偽値を 1 つ持つだけの画面のために行うものではありません。

## この状態をウィジェットの外に出す理由

- **読み手が 2 つ、ソースは 1 つ。** `AppBar` のカートバッジと、2 ルート離れたカート画面は同じ明細を必要とします。`setState` では、状態を共通の祖先へ持ち上げてコールバックを下へ引き回すか、コピーを 2 つ持って一致することを祈るかのどちらかになります。
- **ロジックが単体テスト可能になります。** `Notifier` はただの Dart オブジェクトです。通常の `test()` ブロックの中で `ProviderContainer.test()` から操作でき、`pumpWidget` も `WidgetTester` もフレームのスケジューリングも不要です。
- **必要なときに状態がルートより長生きします。** `NotifierProvider` は `Navigator.pop` をまたいで値を保持します。カート、下書きフォーム、複数ステップのウィザードが実際に必要としているのはこの挙動です。ウィジェットの状態は要素とともに消えます。
- **変更に名前が付きます。** 6 つのコールバックに散らばった `setState(() => _lines = [..._lines, line])` は `cartProvider.notifier.add(line)` になり、ログ出力・ガード・スロットリングを行う場所が 1 か所に集約されます。

とはいえ、これはすべてを移す理由にはなりません。`TextEditingController`、`AnimationController`、`FocusNode`、`ScrollController`、`GlobalKey<FormState>` はウィジェットのものであり、`State` オブジェクトに残すべきです。

## 何が壊れるか

| 領域 | 変更点 | 深刻度 |
| ---- | ------ | ------ |
| ウィジェットの基底クラス | `StatefulWidget` が `ConsumerWidget` になり、コントローラーが残る場合は `ConsumerStatefulWidget` になります | 高 |
| コレクションのその場変更 | Riverpod 3.0 は `==` でフィルタリングするため、`state.add(x)` の後に `state = state` としても再構築されません | 高 |
| `setState` の呼び出し箇所 | `Notifier` 内で `state` に代入する形に置き換わります | 高 |
| `initState` | `Notifier.build()` へ移りますが、これは複数回実行されることがあります | 中 |
| `dispose` | プロバイダーが所有するリソースに限り `ref.onDispose` へ移ります | 中 |
| 状態の寿命 | 生成されたプロバイダーは既定で自動破棄され、手書きのものはされません | 中 |
| `await` 後の `context` | ウィジェット内の `context.mounted` が notifier 内では `ref.mounted` になります | 中 |
| ウィジェットテスト | `pumpWidget` に `ProviderScope` のラップが必要で、無いとすべての読み取りが例外を投げます | 低 |

## 事前チェックリスト

1. マシンと CI の両方で Flutter 3.44 安定版と Dart 3.x であること (`flutter --version`)。
2. `pubspec.yaml` に `flutter_riverpod: ^3.3.2` があり、`ProviderScope` が `runApp` を包んでいること。まだ 2.x の場合は、先にその移行を別作業として済ませてください。[Riverpod 2.x から Riverpod 3.0 への移行](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)を参照してください。
3. コード生成を使うかどうかを、途中ではなく今決めてください。コード生成には `riverpod_annotation: ^4.0.3` に加えて、`dev_dependencies` に `riverpod_generator: ^4.0.4` と `build_runner` が必要です。
4. `analysis_options.yaml` で `riverpod_lint` と `custom_lint` を有効にしてください。`build` メソッド内の `ref.read` を検出してくれます。この移行で最も多い間違いです。
5. 画面に手を入れる前に、現在の挙動を固定するウィジェットテストを 1 本用意してください。必要なのは赤と緑のシグナルであって、雰囲気ではありません。
6. ブランチを切ってください。これは元に戻せますが、小さなコミット 3 つで戻せるものではありません。

## 出発点

すべてを `State` に抱え込み、バッジを更新できるようにコールバックを子まで引き回しているカート画面です。

```dart
// Flutter 3.44, Dart 3.x -- before
class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  List<CartLine> _lines = const [];
  bool _isSubmitting = false;
  final _couponController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lines = CartStorage.instance.load();
  }

  @override
  void dispose() {
    _couponController.dispose();
    super.dispose();
  }

  void _add(CartLine line) {
    setState(() => _lines = [..._lines, line]);
  }

  void _setQuantity(String sku, int quantity) {
    setState(() {
      _lines = [
        for (final l in _lines)
          if (l.sku == sku) l.copyWith(quantity: quantity) else l,
      ];
    });
  }

  Future<void> _submit() async {
    setState(() => _isSubmitting = true);
    await CheckoutApi.submit(_lines);
    if (!mounted) return;
    setState(() => _isSubmitting = false);
  }

  @override
  Widget build(BuildContext context) => CartView(
        lines: _lines,
        isSubmitting: _isSubmitting,
        couponController: _couponController,
        onQuantityChanged: _setQuantity,
      );
}
```

## 移行手順

1. **`State` オブジェクトのフィールドをすべて仕分けします。** コードを書く前に、紙の上で 2 つのリストに分けてください。他のウィジェットが必要としうるドメイン状態 (`_lines`、`_isSubmitting`) は notifier へ移します。このウィジェットの要素に紐づくフレームワークのオブジェクト (`_couponController`、focus node、アニメーションコントローラー、フォームキー) は残します。*検証:* 各フィールドがちょうど 1 つのリストに入っていること、そして「残す」側のどれもが他のルートから読まれていないこと。

2. **状態を 1 つの不変な値としてモデル化します。** ばらけた 2 つのフィールドをクラスにまとめ、`state` への 1 回の代入で画面全体を表現できるようにします。*検証:* `dart analyze` がクリーンで、クラスに `copyWith` があること。

   ```dart
   // Flutter 3.44, Dart 3.x
   class CartState {
     const CartState({this.lines = const [], this.isSubmitting = false});
     final List<CartLine> lines;
     final bool isSubmitting;

     int get itemCount => lines.fold(0, (sum, l) => sum + l.quantity);

     CartState copyWith({List<CartLine>? lines, bool? isSubmitting}) =>
         CartState(
           lines: lines ?? this.lines,
           isSubmitting: isSubmitting ?? this.isSubmitting,
         );
   }
   ```

3. **`Notifier` を書きます。** `build()` が初期状態を返し、`initState` を置き換えます。かつての `setState` のクロージャーはそれぞれ、`state` に代入する public メソッドになります。*検証:* `BuildContext`、`setState`、ウィジェット型への参照が一切ない状態でファイルがコンパイルされること。

   ```dart
   // flutter_riverpod 3.3.2 -- no codegen
   import 'package:flutter_riverpod/flutter_riverpod.dart';

   final cartProvider = NotifierProvider<CartNotifier, CartState>(
     CartNotifier.new,
   );

   class CartNotifier extends Notifier<CartState> {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());

     void add(CartLine line) {
       state = state.copyWith(lines: [...state.lines, line]);
     }

     void setQuantity(String sku, int quantity) {
       state = state.copyWith(
         lines: [
           for (final l in state.lines)
             if (l.sku == sku) l.copyWith(quantity: quantity) else l,
         ],
       );
     }

     Future<void> submit() async {
       state = state.copyWith(isSubmitting: true);
       await CheckoutApi.submit(state.lines);
       if (!ref.mounted) return;
       state = state.copyWith(isSubmitting: false);
     }
   }
   ```

   コード生成版は、プロバイダーが推論されるだけで同じクラスです。

   ```dart
   // riverpod_annotation 4.0.3, riverpod_generator 4.0.4
   @Riverpod(keepAlive: true)
   class Cart extends _$Cart {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());
     // ...same methods
   }
   ```

4. **ウィジェットに触れる前に notifier を単体テストします。** これがこの移行の見返りなので、早めに回収してください。*検証:* `flutter test test/cart_notifier_test.dart` が、ウィジェットを 1 つも描画せずに成功すること。

   ```dart
   // flutter_riverpod 3.3.2
   test('setQuantity replaces the matching line', () {
     final container = ProviderContainer.test();
     container.read(cartProvider.notifier).add(const CartLine(sku: 'A', quantity: 1));
     container.read(cartProvider.notifier).setQuantity('A', 3);
     expect(container.read(cartProvider).itemCount, 3);
   });
   ```

5. **ウィジェットを変換します。** 手順 1 で何も残らなかった場合、`StatefulWidget` は `ConsumerWidget` に縮み、`build` が `WidgetRef` を受け取ります。この画面はクーポンのコントローラーが残るため、代わりに `ConsumerStatefulWidget` になります。*検証:* `riverpod_lint` のルールを含めて `flutter analyze` の指摘がゼロであること。

   ```dart
   // Flutter 3.44, flutter_riverpod 3.3.2 -- after
   class CartScreen extends ConsumerStatefulWidget {
     const CartScreen({super.key});
     @override
     ConsumerState<CartScreen> createState() => _CartScreenState();
   }

   class _CartScreenState extends ConsumerState<CartScreen> {
     final _couponController = TextEditingController();

     @override
     void dispose() {
       _couponController.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) {
       final cart = ref.watch(cartProvider);
       return CartView(
         lines: cart.lines,
         isSubmitting: cart.isSubmitting,
         couponController: _couponController,
         onQuantityChanged: (sku, qty) =>
             ref.read(cartProvider.notifier).setQuantity(sku, qty),
       );
     }
   }
   ```

6. **すべての呼び出し箇所に watch と read の使い分けを適用します。** 再構築してほしいので `build` では `ref.watch`、再構築してほしくないのでコールバックでは `ref.read(provider.notifier)` を使います。`onPressed` の中で `ref.watch` を呼んではいけません。*検証:* ファイル内を `ref.read(` で検索し、すべての一致箇所がコールバックか非同期メソッドの中にあり、`build` の中に無いことを確認してください。

7. **引き回していたコールバックを削除し、もう一方のウィジェットに直接監視させます。** この手順こそが移行の元を取る部分です。バッジはコンストラクター 3 つを経由して個数を受け取るのをやめ、自分でプロバイダーを読みます。*検証:* 中間のウィジェットが削除したパラメーターを宣言していないこと、そしてカート画面で商品を追加すると別ルートのバッジが更新されること。

   ```dart
   // flutter_riverpod 3.3.2
   class CartBadge extends ConsumerWidget {
     const CartBadge({super.key});
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final count = ref.watch(cartProvider.select((s) => s.itemCount));
       return Badge(label: Text('$count'));
     }
   }
   ```

   ここでは `select` が重要です。これが無いとバッジは `isSubmitting` が切り替わるたびに再構築されます。`setState` の頃はそもそもそのウィジェットのサブツリーに無かったので、一度も起きなかったことです。

8. **プロバイダーが所有するクリーンアップを `ref.onDispose` へ移します。** notifier が作ったもの (`StreamSubscription`、タイマー、ソケット) はウィジェットの `dispose` ではなくそこで解放します。*検証:* 画面を切り替えて戻し、ログに重複した購読が出ないことを確認してください。

   ```dart
   @override
   CartState build() {
     final sub = PriceFeed.stream.listen(_onPriceChanged);
     ref.onDispose(sub.cancel);
     return CartState(lines: CartStorage.instance.load());
   }
   ```

## 検証

マージ前に次のリストを実行してください。

- `riverpod_lint` を有効にした状態で `flutter analyze` の指摘がゼロであること。
- `flutter test` が成功し、ウィジェットテストが画面を `ProviderScope` で包んでいること。包んでいないと、最初の `ref.watch` はコンパイル時ではなく実行時に例外を投げます。
- 画面が構築され、かつて `setState` を使っていた操作がすべて引き続き UI を更新すること。ひとつずつ触って確認してください。`==` フィルタリングの失敗 (後述) はエラーを出さず、ウィジェットが固まるだけです。
- 画面を push し、pop し、もう一度 push してください。状態の永続性が、偶然そうなったものではなく意図どおりであることを確認します。
- DevTools の profile モードでの確認。親の再構築回数は以前と同じか少なくなるはずです。増えているなら `select` が足りていません。

## ロールバック計画

この移行は、専用ブランチで進めていれば `git revert` で元に戻せます。ディスク上にもネットワーク越しにも変更が無いためです。revert で戻らない唯一のものは、新しい寿命に依存していた挙動です。すでにリリース済みで、戻る操作をしてもカートが残ることにユーザーが慣れているなら、ウィジェットローカルな状態へ戻すと pop 時に何も言わずカートが消えます。コードを戻したうえで、ビルドだけでなくナビゲーションのフローも再テストしてください。

## 遭遇した落とし穴

**その場変更で再構築されなくなりました。** `setState` の下では、クロージャー内の `_lines.add(line)` は動いていました。`setState` は何が変わったかに関係なく要素を dirty にするからです。Riverpod 3.0 は新旧の状態を `==` で比較し、等しければ通知を飛ばします。したがって次のコードは何もしません。

```dart
// broken on flutter_riverpod 3.x
void add(CartLine line) {
  state.lines.add(line); // mutates the same List instance
  state = state;         // identical, == is true, no listeners notified
}
```

手順 3 のように、常に新しい値を作ってください。これは [Riverpod 3.0 の StreamProvider がイベントを出さなくなる](/ja/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/)ときに人を戸惑わせるのと同じ等価性フィルタリングです。状態クラスが `equatable` や `freezed` の値型を使っている場合はさらに厳しく、正しく作り直したオブジェクトでも中身が変わっていなければフィルタされます。

**`build()` は `initState` ではありません。** `initState` は要素につき 1 回走ります。`Notifier.build()` は監視している依存が変わるたびに再実行され、`state` を戻り値でリセットします。`build()` の中で `ref.watch(authProvider)` を呼んでいると、トークンの更新でカートが消し飛びます。初期化時だけ欲しい値には `ref.read` を使い、`build()` 内の `ref.watch` は本当に状態をリセットすべき依存に限定してください。

**自動破棄の既定値が 2 つの記法で異なります。** 手書きの `NotifierProvider(CartNotifier.new)` は既定で生存し続け、`isAutoDispose: true` で自動破棄を有効にします。生成された `@riverpod` プロバイダーは既定で自動破棄され、`@Riverpod(keepAlive: true)` で無効にします。1 つのコードベースで両方の記法を書いているチームでは、ある画面ではカートが勝手に空になり、別の画面ではならないという状態になり、それを説明するエラーはどこにも出ません。

**`mounted` の置き場所が変わりました。** ウィジェット内では引き続き `context.mounted` と、おなじみの[非同期ギャップ後の `mounted` ガード](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)を使います。notifier 内には `BuildContext` が無いため、チェックは [await 後の `ref.mounted`](/ja/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) になります。忘れると、リクエストの実行中にプロバイダーが破棄されていた場合に例外が飛びます。

**コントローラーは notifier のものではありません。** `TextEditingController` をプロバイダーの状態に置くと整理されて見えますが、プロバイダーがウィジェットより長生きした瞬間、リスナーが失われたコントローラーに文字を入力することになります。[コントローラーの破棄ルール](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)は、元あった場所のままにしてください。

## 関連記事

- [2026 年の Flutter 状態管理における Provider と Riverpod と Bloc の比較](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)。移行先をまだ選んでいる場合に読んでください。
- [Riverpod 2.x から Riverpod 3.0 への移行](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)。本記事より先に済ませておくアップグレードです。
- [FutureBuilder から Riverpod の AsyncNotifier への移行](/ja/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)。本記事の非同期版にあたります。
- [どの Riverpod パッケージが本当に必要か](/ja/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)。`riverpod` と `flutter_riverpod` は交換可能ではありません。
- [AsyncValue でローディングとエラーの状態を表示する](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)。notifier が IO を始めたら読んでください。

## 参考資料

- [Riverpod 3.0 の新機能](https://riverpod.dev/docs/whats_new)。統一された `Ref`、`ref.mounted`、`ProviderContainer.test()`、`==` による通知フィルタリングについて。
- [Riverpod のプロバイダーリファレンス](https://riverpod.dev/docs/concepts2/providers)。`Notifier` と `build()` の契約について。
- [Riverpod の自動破棄](https://riverpod.dev/docs/concepts2/auto_dispose)。`isAutoDispose` と `ref.keepAlive()` について。
- [2.0 から 3.0 への移行](https://riverpod.dev/docs/3.0_migration)。`AutoDispose` インターフェースの削除について。
- [pub.dev の flutter_riverpod](https://pub.dev/packages/flutter_riverpod) と [pub.dev の riverpod_generator](https://pub.dev/packages/riverpod_generator)。3.3.2 と 4.0.4 のバージョン固定について。
- [Flutter のリリースノート](https://docs.flutter.dev/release/release-notes)。3.44 安定版という前提について。

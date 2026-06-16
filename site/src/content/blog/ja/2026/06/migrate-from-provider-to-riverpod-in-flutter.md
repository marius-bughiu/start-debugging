---
title: "Flutter で provider から Riverpod へ移行する (provider 6.1.5 から Riverpod 3.x へ)"
description: "実際の Flutter アプリで provider パッケージから Riverpod 3.x へ段階的に移行する手順です。ChangeNotifierProvider から Notifier へ、MultiProvider から ProviderScope へ、context.watch から ref.watch へ、ProxyProvider から ref.watch による合成へ、加えて引っかかりやすい等価性とライフサイクルの落とし穴も解説します。Flutter 3.27.1、Dart 3.11、provider 6.1.5、flutter_riverpod 3.3.1 で検証済みです。"
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "provider"
  - "state-management"
  - "migration"
lang: "ja"
translationOf: "2026/06/migrate-from-provider-to-riverpod-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-16
---

手短に言うと、`provider` と並べて `flutter_riverpod` を追加し、アプリを `MultiProvider` の代わりに `ProviderScope` でラップして、依存ツリーの末端から 1 つの機能ずつ移行します。各 `ChangeNotifier` は `Notifier` (非同期処理なら `AsyncNotifier`) になり、`context.watch<T>()` は `ref.watch(myProvider)` に、`Provider.of` と `context.read` は `ref.read` に、そしてすべての `ProxyProvider` は別のプロバイダーを単純に `ref.watch` するだけになります。小〜中規模のアプリなら 1〜3 日の作業です。難しいのは構文ではなく、Riverpod が状態を等価性で比較し、`provider` とは異なる方法でプロバイダーを生かし続ける点です。Flutter 3.27.1、Dart 3.11、provider 6.1.5、flutter_riverpod 3.3.1、riverpod_annotation 2.6.1、riverpod_generator 2.6.5 で検証済みです。

`provider` パッケージ (現在は 6.1.5) は 2019 年以来 Flutter の状態管理における定番の答えであり、今でも問題なく動作します。しかしその作者である Remi Rousselet は、`provider` の構造的な問題を解決するために Riverpod を作りました。`BuildContext` を通して状態を読むということは、コンパイルエラーではなく実行時の `ProviderNotFoundException` を意味し、`ProxyProvider` のネストは依存が 2 つを超えると読めなくなり、`ValueKey` の小細工なしには同じ型のプロバイダーを 2 つ持てません。Riverpod はメンタルモデル (変化したときにウィジェットを再構築するオブジェクトのグラフ) を維持しつつ、`BuildContext` との結合を取り除きます。このガイドは、書き直しを必要としない、末端優先の機械的な移行手順です。

## なぜ provider から移行するのか

- **`ProviderNotFoundException` ではなくコンパイル時の安全性。** `provider` では、ツリー上で自分より上にない型を読むと実行時に例外が投げられます。Riverpod ではプロバイダーはトップレベルのグローバルなので、タイプミスはコンパイルエラーになり、「見つける」べきものは何もありません。
- **もう `MultiProvider` のピラミッドは不要。** Riverpod には組み立てるべきプロバイダーのツリーがありません。ルートに 1 つの `ProviderScope` を置くだけで `MultiProvider(providers: [...])` のリスト全体を置き換えられ、プロバイダー間の依存はネストの順序ではなく `ref.watch` で表現されます。
- **同じ型のプロバイダーを 2 つ、無料で。** `provider` はすべてを型でキー付けするため、2 つの `ChangeNotifierProvider<CartModel>` は衝突します。Riverpod はプロバイダーオブジェクトでキー付けするので、これは問題になりません。
- **きちんと合成できる auto-dispose と family。** Riverpod は `autoDispose` とパラメーター化された (`family`) プロバイダーをファーストクラスの機能として提供します。`provider` ではこれを手動の `ChangeNotifierProvider.value` とキー管理で近似するしかありません。

## 何が壊れるか

| Area | Change | Severity |
| --- | --- | --- |
| Root wiring | `MultiProvider` replaced by a single `ProviderScope` | medium |
| Reads | `context.watch<T>()` / `Provider.of<T>(context)` replaced by `ref.watch` / `ref.read` | high |
| Notifiers | `ChangeNotifier` + `notifyListeners()` replaced by `Notifier` + state reassignment | high |
| Rebuild semantics | Riverpod compares state by `==`; in-place mutation no longer rebuilds | high |
| Composition | `ProxyProvider` replaced by `ref.watch` of the dependency | medium |
| Widgets | `StatelessWidget` / `StatefulWidget` become `ConsumerWidget` / `ConsumerStatefulWidget` | medium |
| Lifecycle | `provider` disposes when removed from the tree; Riverpod keeps state until `autoDispose` | medium |

再構築とノティファイアーに関する 2 つの `high` の行が、チームが時間を浪費する箇所です。それ以外はすべて検索と置換で済みます。

## 事前チェックリスト

- Flutter 3.27.1 / Dart 3.11 (またはそれ以降) がインストールされていること: `flutter --version`。
- クリーンな `git` 作業ツリーと、捨てられるブランチ。
- 今日登録しているすべてのプロバイダーの一覧。コードベースを grep します: `grep -rn "ChangeNotifierProvider\|ProxyProvider\|FutureProvider\|StreamProvider\|Provider.of\|context.watch\|context.read" lib/`。
- それぞれに対して、何かが依存しているかどうかのメモ。何も依存していないものから先に移行します。
- 動作するテストスイート。薄いものでも構いません。各ステップのあとに実行します。

## 移行手順

1. **`pubspec.yaml` で provider の隣に Riverpod を追加します。** `provider` をまだ削除しないでください。両方のパッケージは別々のツリーを所有するため共存できます。ある状態の一片は常にちょうど 1 つの所有者を持つので、型単位ではなく機能単位で移行します。

   ```yaml
   # pubspec.yaml. Flutter 3.27.1, Dart 3.11.
   dependencies:
     flutter:
       sdk: flutter
     provider: ^6.1.5            # keep until migration is done
     flutter_riverpod: ^3.3.1
     riverpod_annotation: ^2.6.1

   dev_dependencies:
     build_runner: ^2.4.13
     riverpod_generator: ^2.6.5
     custom_lint: ^0.7.0
     riverpod_lint: ^2.6.5
   ```

   確認: `flutter pub get` がバージョン競合なしで解決すること。

2. **アプリのルートを `ProviderScope` でラップし、今のところその内側に `MultiProvider` を残します。** `ProviderScope` は Riverpod がすべてのプロバイダーの状態を保存する場所です。これはプロバイダーのリストではなく、1 つの境界です。未移行の画面が動き続けるように、既存の `MultiProvider` をその下に残しておきます。

   ```dart
   // lib/main.dart, Flutter 3.27.1
   import 'package:flutter/material.dart';
   import 'package:flutter_riverpod/flutter_riverpod.dart';
   import 'package:provider/provider.dart';

   void main() {
     runApp(
       ProviderScope(                       // Riverpod root
         child: MultiProvider(              // legacy, shrinks as you migrate
           providers: [
             ChangeNotifierProvider(create: (_) => CartModel()),
             ChangeNotifierProvider(create: (_) => AuthModel()),
           ],
           child: const MyApp(),
         ),
       ),
     );
   }
   ```

   確認: アプリが今まで通りビルドされ、同じように動作すること。まだ何も移動していません。

3. **末端の `ChangeNotifier` を 1 つ `Notifier` に変換します。** 他に何も依存していないモデルを選びます。`provider` ではフィールドを変更して `notifyListeners()` を呼びます。Riverpod では `build()` が初期状態を返し、通知するには `state` を再代入します。`notifyListeners()` はありません。

   ```dart
   // Before: provider 6.1.5
   class CartModel extends ChangeNotifier {
     final List<Item> _items = [];
     List<Item> get items => List.unmodifiable(_items);

     void add(Item item) {
       _items.add(item);
       notifyListeners();
     }
   }
   ```

   ```dart
   // After: flutter_riverpod 3.3.1, code generation
   import 'package:riverpod_annotation/riverpod_annotation.dart';

   part 'cart_model.g.dart';

   @riverpod
   class Cart extends _$Cart {
     @override
     List<Item> build() => const [];

     void add(Item item) {
       state = [...state, item];   // new list, not state.add(...)
     }
   }
   ```

   `dart run build_runner build --delete-conflicting-outputs` を実行して `cartProvider` を生成します。確認: ジェネレーターがエラーなく `cart_model.g.dart` を生成すること。

4. **それを消費する画面を `ConsumerWidget` に切り替えます。** `StatelessWidget` は `ConsumerWidget` になり、`build` には `WidgetRef ref` が加わります。`context.watch<CartModel>()` は `ref.watch(cartProvider)` になります。メソッド呼び出しの場合、`context.read<CartModel>().add(x)` は `ref.read(cartProvider.notifier).add(x)` になります。

   ```dart
   // Before
   class CartView extends StatelessWidget {
     @override
     Widget build(BuildContext context) {
       final items = context.watch<CartModel>().items;
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => context.read<CartModel>().add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   ```dart
   // After
   class CartView extends ConsumerWidget {
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final items = ref.watch(cartProvider);
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => ref.read(cartProvider.notifier).add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   ウィジェットがすでに独自の状態を持っていた場合は、`ConsumerStatefulWidget` と `ConsumerState` を使います。そこでは `ref` がフィールドとして利用できます。`MultiProvider` から `ChangeNotifierProvider(create: (_) => CartModel())` の行を削除します。確認: 画面が同じように動作し、`MultiProvider` のリストが 1 つ短くなっていること。

5. **`ProxyProvider` を `ref.watch` による合成に置き換えます。** これは最も多くのコードを削除するステップです。A から B を構築する `ProxyProvider` は、単に A を watch するプロバイダーになります。

   ```dart
   // Before: ProxyProvider wiring
   ProxyProvider<AuthModel, ApiClient>(
     update: (_, auth, __) => ApiClient(token: auth.token),
   ),
   ```

   ```dart
   // After: a provider that watches its dependency
   @riverpod
   ApiClient apiClient(ApiClientRef ref) {
     final token = ref.watch(authProvider.select((a) => a.token));
     return ApiClient(token: token);
   }
   ```

   `ref.watch(...select(...))` は `provider` の `context.select` の直接的な置き換えであり、これにより `apiClient` は `AuthModel` の更新ごとではなく `token` が変化したときだけ再構築されます。確認: 上流のプロバイダーが変化したときに依存するウィジェットが再構築されること。

6. **`FutureProvider` と `StreamProvider` を Riverpod 版に移行します。** 名前は同じで、配線だけが異なります。`provider` の `FutureProvider` は `context.watch<AsyncSnapshot>` 形式の配線で読みますが、Riverpod のものは直接 switch できる `AsyncValue<T>` を返します。

   ```dart
   // After: flutter_riverpod 3.3.1
   @riverpod
   Future<User> currentUser(CurrentUserRef ref) {
     return ref.watch(apiClientProvider).fetchUser();
   }

   // in a ConsumerWidget
   final userAsync = ref.watch(currentUserProvider);
   return userAsync.when(
     data: (user) => Text(user.name),
     loading: () => const CircularProgressIndicator(),
     error: (e, _) => Text('Failed: $e'),
   );
   ```

   確認: 手動の `bool isLoading` フラグなしでローディングとエラーの状態が描画されること。このパターンの詳細については、下記のリンク先の AsyncValue の記事を参照してください。

7. **`provider` への依存を削除します。** `MultiProvider` が空になったら `main.dart` から削除し、続いて `pubspec.yaml` から `provider: ^6.1.5` を取り除いて `flutter pub get` を実行します。コンパイラーが残っている `context.watch`/`context.read`/`Provider.of` の呼び出しを指摘します。確認: `package:provider` への参照がゼロでプロジェクトがコンパイルされること。

## 検証

最後のステップのあとだけでなく、各ステップのあとにこのチェックリストを実行します。

- `flutter analyze` がエラーも `riverpod_lint` の警告も報告しないこと。
- `dart run build_runner build --delete-conflicting-outputs` がクリーンに完了すること。
- `flutter test` が通ること。Riverpod のテストは `ProviderContainer` (または 3.x では `ProviderContainer.test()`) と `container.read(provider)` を使い、古い `ChangeNotifier` のユニットテストを置き換えます。
- 手動のスモークテスト: 移行したすべての画面が状態変化で再構築され続け、どの画面も `ProviderNotFoundException` を投げないこと (構造上、残っているものはないはずです)。
- `grep -rn "package:provider" lib/` が何も返さないこと。

## ロールバック計画

この移行は、両方のパッケージが共存するからこそ、機能単位で元に戻せます。移行した画面が誤動作する場合は、その画面のコミットを取り消します。`MultiProvider` に `ChangeNotifierProvider` の行を戻し、`ChangeNotifier` クラスを復元し、ウィジェットを `StatelessWidget` に戻します。末端優先で 1 コミットにつき 1 機能を移行したため、どのロールバックも 1 つを超える画面に触れることはありません。これがシーケンスの中で唯一の一方通行の扉なので、確信が持てるまでは `pubspec.yaml` から `provider` を削除 (ステップ 7) しないでください。

## ぶつかった落とし穴

**インプレースの変更が再構築を止めます。** これが第 1 の驚きです。`provider` では通知を自分で制御するので `_items.add(x); notifyListeners()` が機能します。Riverpod の `Notifier` では、フレームワークは古い値と `==` でない値が `state` に代入されたときだけ再構築します。`state.add(x)` は同じリストを変更し、参照は変わらず、何も再構築されません。常に新しいコレクションを代入してください: `state = [...state, x]`。同じことはモデルオブジェクトにも当てはまります。だからこそイミュータブルな状態 (レコード、`copyWith`、または `freezed` クラス) は Riverpod と自然に組み合わさります。

**ウィジェットがツリーから外れてもプロバイダーは破棄されません。** `provider` の `ChangeNotifierProvider` は、そのサブツリーが削除されると破棄されます。Riverpod のプロバイダーは、デフォルトでは `ProviderScope` の寿命の間ずっと状態を保持します。画面から離れたときにその画面のコントローラーがリセットされることに頼っていた場合は、`autoDispose` が必要になります (コード生成を使う場合は、`ref.keepAlive()` を呼ばない限り、アノテーション付きプロバイダーではそれがデフォルトです)。古い動作がツリーベースの破棄に依存していたプロバイダーをすべて監査してください。

**`build()` の中の `ref.read` は罠です。** `Notifier.build()` やウィジェットの `build` の中で別のプロバイダーを `ref.read` で読むと、値を一度スナップショットして二度と更新されません。反応すべきものには `ref.watch` を使い、`ref.read` はボタンのコールバックのようなイベントハンドラーに限定してください。`riverpod_lint` はこれらの大半を指摘してくれます。だからこそこの開発依存は初日にインストールする価値があります。

**`Consumer` は両方のパッケージに存在します。** 移行中に両方をインポートすると、`Consumer` が曖昧になります。Riverpod の `Consumer` は `(context, ref, child)` のビルダーを取り、`provider` のものは `(context, value, child)` を取ります。provider 時代のウィジェットに Riverpod の `Consumer` を落とし込むのではなく、ウィジェット全体を `ConsumerWidget` に変換することを優先すれば、インポートの衝突を完全に避けられます。

この移行は退屈であることが報われます。1 つの末端、1 つのコミット、テストを実行、繰り返し。`pubspec.yaml` から `provider` を削除する頃には、危険な部分は何週間も前に小さく可逆的なステップの中で済んでいます。

## 関連記事

- 別の状態管理ライブラリから来ている場合は、[GetX から Riverpod への移行](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)が、より重いフレームワークについて同じ末端優先のアプローチを解説しています。
- まだ迷っていますか。[provider と Riverpod と Bloc の比較](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)が、決める前にトレードオフを整理しています。
- 非同期の側面については、[AsyncValue によるローディングとエラーの状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)が `when` と `AsyncNotifier` について深く掘り下げています。
- 素の `FutureBuilder` から来ていますか。[FutureBuilder/StreamBuilder と Riverpod AsyncValue の比較](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)を参照してください。
- 移行後に最もよく起きる実行時エラー: [Cannot use ref after the widget was disposed の修正](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)。

## 参考資料

- [Riverpod docs: migrating from pkg:provider (quickstart)](https://riverpod.dev/docs/from_provider/quickstart)
- [Riverpod docs: from ChangeNotifier](https://riverpod.dev/docs/migration/from_change_notifier)
- [Riverpod docs: what's new in 3.0](https://riverpod.dev/docs/whats_new)
- [provider 6.1.5 on pub.dev](https://pub.dev/packages/provider/versions/6.1.5)
- [flutter_riverpod changelog](https://pub.dev/packages/flutter_riverpod/changelog)

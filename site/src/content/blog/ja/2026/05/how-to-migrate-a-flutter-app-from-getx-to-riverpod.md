---
title: "Flutter アプリを GetX から Riverpod へ移行する方法"
description: "実際の Flutter アプリで GetX から Riverpod 3.x への段階的な移行を解説します。GetxController から Notifier、.obs から派生プロバイダー、Get.find から ref.watch、Get.to から go_router、さらに snackbar、テーマ、テストまで。Flutter 3.27.1、Dart 3.11、flutter_riverpod 3.3.1 で動作確認済み。"
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "getx"
  - "state-management"
  - "migration"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod"
translatedBy: "claude"
translationDate: 2026-05-06
---

短くまとめます。GetX の隣に `flutter_riverpod` をインストールし、アプリを `ProviderScope` でラップして、画面を 1 つずつ移行します。各 `GetxController` を `Notifier` (非同期処理であれば `AsyncNotifier`) に置き換え、すべての `.obs` フィールドを Notifier の状態か、それを派生させる `Provider` に置き換えます。`Get.find<T>()` を `ref.watch(myProvider)` に置き換え、ルーティングは `go_router` に移すことで、ようやく `Get.to` を捨てられます。snackbar、ダイアログ、テーマ変更は通常の Flutter API に対して作り直します。Flutter 3.27.1、Dart 3.11、flutter_riverpod 3.3.1、riverpod_generator 2.6.5、go_router 14.6 で動作確認済みです。

GetX が普及したのは、あらゆる疑問に 1 つの import で答えてくれたからです。状態、ルート、依存性注入、snackbar、国際化、テーマまですべて `package:get` 1 つで賄えました。それが 2021 年には強みでしたが、2026 年には問題になりました。ランタイムの半分を所有する単一の依存関係、`BuildContext` を介さないショートカット文化 (`Get.context!`、`Get.snackbar`) によってアプリの挙動が追いにくくなる点、そして Flutter のリリースペースに追いついていないメンテナンスサイクルです。Riverpod は逆のトレードオフを取ります。ひとつのこと (明示的な依存を持つ状態グラフ) だけを行い、ルーティングや UI シェルは標準の Flutter API に頼らせます。移行の大半は機械的ですが、いくつかのパターンは抵抗してきます。本記事ではあらゆるチームが引っかかるそれらのパターンを順に見ていきます。

## 実際に翻訳しているもの

コードに手を付ける前に、GetX が自分のために何をしているかを書き出してみてください。多くのアプリは次の 5 つに依存しています。

1. 状態のための `GetxController` と `Rx<T>` / `.obs`。
2. 依存性注入のための `Get.put` / `Get.lazyPut` / `Get.find`。
3. 状態変更時にウィジェットを再構築するための `Obx` と `GetBuilder`。
4. ナビゲーションのための `Get.to`、`Get.toNamed`、`Get.back`。
5. UI 副作用のための `Get.snackbar`、`Get.dialog`、`Get.changeTheme`。

Riverpod は適切なコード生成のボイラープレートを使えば、1 から 3 を直接扱えます。一方、4 と 5 は設計上扱いません。ナビゲーションは `go_router` (または組み込みの `Navigator`) で置き換え、snackbar、ダイアログ、テーマ変更はプロバイダーから状態を読む通常の Flutter ウィジェットに戻ります。これは移行で人を驚かせる部分です。Riverpod は GetX よりもスコープが狭く、それこそが要点なのです。

## GetX を残したまま Riverpod を追加する

段階的な移行は、両方のライブラリが共存できる場合のみ機能します。共存はできますが、注意点が 1 つあります。`Get.put` は独自のサービスロケーターを保持し、Riverpod は独自のプロバイダーツリーを持つため、ある状態の所有者は常に 1 つです。所有者は型単位ではなく画面単位で選んでください。

```yaml
# pubspec.yaml. Flutter 3.27.1, Dart 3.11.
dependencies:
  flutter:
    sdk: flutter
  get: ^4.7.2
  flutter_riverpod: ^3.3.1
  riverpod_annotation: ^2.6.1
  go_router: ^14.6.2

dev_dependencies:
  build_runner: ^2.4.13
  riverpod_generator: ^2.6.5
  custom_lint: ^0.7.0
  riverpod_lint: ^2.6.5
```

既存の `GetMaterialApp` を `ProviderScope` でラップします。ルーティングが移行されるまで `GetMaterialApp` を残しておけます。2 つのツリーが衝突することはありません。

```dart
// lib/main.dart, Flutter 3.27.1
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:get/get.dart';

void main() {
  runApp(const ProviderScope(child: MyApp()));
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return GetMaterialApp(
      title: 'Migrating to Riverpod',
      home: const HomePage(),
      getPages: const [
        // existing GetX routes for screens not yet migrated
      ],
    );
  }
}
```

`riverpod_lint` を `analysis_options.yaml` に一度追加してください。最も痛い 2 つのミスを検出してくれます。すなわち、build 中に `ref.read` でプロバイダーを読み取ってしまうこと、そして notifier を保存するときに `final` を付け忘れることです。

## GetxController から Notifier への機械的な変換パス

最もシンプルなコントローラーから始めましょう。カウンターは GetX の hello-world であり、変換はほぼ 1 行ずつ対応します。

```dart
// Before: GetX 4.7, Flutter 3.27.1
import 'package:get/get.dart';

class CounterController extends GetxController {
  final RxInt count = 0.obs;
  final RxBool busy = false.obs;

  Future<void> incrementAfterDelay() async {
    busy.value = true;
    await Future.delayed(const Duration(milliseconds: 200));
    count.value++;
    busy.value = false;
  }
}
```

Riverpod 3.x の同等品はコード生成を利用します。生成された `counterProvider` が `Get.put` と `Obx` の役割を兼ねます。状態を所有し、依存先の再構築方法を知っており、誰も読み取らなくなれば自動で破棄されます。

```dart
// After: flutter_riverpod 3.3.1, riverpod_generator 2.6.5, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

class CounterState {
  const CounterState({this.count = 0, this.busy = false});

  final int count;
  final bool busy;

  CounterState copyWith({int? count, bool? busy}) =>
      CounterState(count: count ?? this.count, busy: busy ?? this.busy);
}

@riverpod
class Counter extends _$Counter {
  @override
  CounterState build() => const CounterState();

  Future<void> incrementAfterDelay() async {
    state = state.copyWith(busy: true);
    await Future.delayed(const Duration(milliseconds: 200));
    state = state.copyWith(count: state.count + 1, busy: false);
  }
}
```

`dart run build_runner watch -d` を一度実行し、起動したままにしておきます。ジェネレーターが `counterProvider` を生成し、ウィジェットは以前 `Obx` を読んでいたのと同じ方法でそれを読み取ります。

```dart
// flutter_riverpod 3.3.1
class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(counterProvider);
    final ctrl = ref.read(counterProvider.notifier);
    return Scaffold(
      body: Center(
        child: s.busy
            ? const CircularProgressIndicator()
            : Text('${s.count}'),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: ctrl.incrementAfterDelay,
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

身につけるべきことが 2 つあります。第一に、`ref.watch` は購読しますが `ref.read` は購読しません。`ref.read` はコールバック (ボタンタップやライフサイクルメソッド) の中だけで使い、build メソッド内では決して使わないでください。第二に、`state =` の代入は `count.value++` とその再構築を原子的にまとめて行います。`busy.value = true` と再構築の間に他の誰かが不整合なフィールドの組を観測する瞬間がもう存在しません。この変更ひとつで、GetX アプリが蓄積しがちなバグの一群が消えます。

## 非同期処理: AsyncNotifier が手動の loading フラグを置き換える

ほとんどの GetX コントローラーは `isLoading.obs` を独自に持っています。`RxFuture` には荒削りな部分があるからです。Riverpod は非同期を `AsyncValue<T>` という第一級の状態として扱います。同じ「ユーザー一覧を取得する」パターンは、これだけに圧縮されます。

```dart
// flutter_riverpod 3.3.1, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'users.g.dart';

@riverpod
class Users extends _$Users {
  @override
  Future<List<User>> build() async {
    final api = ref.watch(apiClientProvider);
    return api.fetchUsers();
  }

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchUsers());
  }
}
```

ウィジェット側は、boolean フィールドを 1 つも書かずに loading、error、data の各状態を取得できます。

```dart
class UsersPage extends ConsumerWidget {
  const UsersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(usersProvider);
    return users.when(
      data: (list) => ListView(children: [for (final u in list) Text(u.name)]),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Failed: $e')),
    );
  }
}
```

Riverpod 3.0 はまた、失敗したプロバイダーをデフォルトで自動的に再試行します。それを望まない場合 (たとえば 401 は再試行すべきでない場合)、プロバイダーまたは `ProviderScope` 全体に `retry: (count, error) => null` を設定してください。切り替える前に [3.0 の retry 移行ノート](https://riverpod.dev/docs/3.0_migration) を読んでください。デフォルトの動作は本当に便利ですが、テストで一時的なバグを覆い隠す可能性があります。

## 依存性注入: Get.find は ref.watch になる

GetX はグローバルなサービスロケーターを使います。アプリのどこからでも `Get.find<ApiClient>()` は同じインスタンスを返します。Riverpod はそれを、`ProviderContainer` ごとに値を一度構築するプロバイダーで置き換えます。

```dart
// flutter_riverpod 3.3.1
@riverpod
ApiClient apiClient(Ref ref) {
  final dio = ref.watch(dioProvider);
  return ApiClient(dio);
}

@riverpod
Dio dio(Ref ref) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'));
  ref.onDispose(() => dio.close(force: true));
  return dio;
}
```

`ref.onDispose` は GetX がきれいな答えを持っていなかった部分です。`dioProvider` の最後のコンシューマーがいなくなれば HTTP クライアントは閉じられ、再び現れればプロバイダーは再構築され新しい `Dio` が得られます。ライフサイクルがついに明示的になりました。本当に永続的に生かしたいサービスについては、プロバイダーに `keepAlive: true` を付ける (または `autoDispose` を使わない) ようにし、`Get.put(permanent: true)` がホットリスタートを生き延びることを期待するのではなく、その判断をコードで明示的に所有してください。

移行中に両方の DI システムを動作させ続けるために、GetX で解決されたシングルトンを Riverpod のコンシューマーに渡す小さなブリッジを登録します。

```dart
// Bridge: read from GetX, expose as a Riverpod provider
@riverpod
LegacyAuthService legacyAuth(Ref ref) => Get.find<LegacyAuthService>();
```

GetX 側に登録すべきものが何も残らなくなり次第、ブリッジを取り除きます。

## リアクティブな派生: .obs が真価を発揮する場面と、Riverpod による置き換え

`.obs` は派生状態を無料に見せます。`final fullName = ''.obs;` と `ever(firstName, (_) => fullName.value = '$firstName $lastName')` の 1 行ずつで済みます。Riverpod の同等品は、入力を列挙する別のプロバイダーです。

```dart
// flutter_riverpod 3.3.1
@riverpod
String fullName(Ref ref) {
  final first = ref.watch(firstNameProvider);
  final last = ref.watch(lastNameProvider);
  return '$first $last';
}
```

利点は、`fullNameProvider` が入力のいずれかが実際に変化したときだけ再計算され (Riverpod 3 は等価性のフィルタリングに `==` を使い、これは古い `identical` チェックからのアップグレードです)、それを読んでいるどのウィジェットも、派生した文字列が変わったときだけ再構築される点です。コストは、すべての入力に名前を付けねばならないことです。その命名こそが、移行で最も難しい編集上の判断です。すべてを 1 つの巨大な notifier に詰め込みたくなる誘惑に抵抗してください。小さなプロバイダーの方がコンポーズしやすく、テストもはるかに容易です。

キャンセルが必要な派生 (ユーザーが入力するたびにネットワークを叩く検索ボックスなど) では、`AsyncNotifier` を使い、`ref.onDispose` と `CancelToken` でキャンセルしてください。これによって GetX の `debounce(query, ..., time: ...)` を、ユニットテストに耐えるコードに置き換えられます。

## ルーティング: Get.to を捨てて go_router を採用する

これはチームが最も後回しにしがちなステップです。GetX のルーティングは実際のところ機能しているからです。それでも、コストは早めに払いましょう。`go_router` がナビゲーションを所有すれば、コントローラー内で `Get.context` が要らなくなるので、移行の残りは加速します。

```dart
// go_router 14.6.2, Flutter 3.27.1
final goRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const HomePage()),
      GoRoute(path: '/users/:id', builder: (_, s) => UserPage(id: s.pathParameters['id']!)),
    ],
    redirect: (ctx, state) {
      final auth = ProviderScope.containerOf(ctx).read(authProvider);
      if (!auth.isLoggedIn && state.matchedLocation != '/login') return '/login';
      return null;
    },
  );
});

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(goRouterProvider);
    return MaterialApp.router(
      routerConfig: router,
      theme: ref.watch(themeProvider),
    );
  }
}
```

`Get.to(NextPage())` を `context.go('/next')` に、`Get.toNamed('/users/42')` を `context.go('/users/42')` に、`Get.back()` を `context.pop()` に置き換えます。文字列型のパスは最初は型付きのページコンストラクターからの劣化に感じますが、実際には文字列をラップする薄い `extension` を `BuildContext` に書き、リンクのチェックは `go_router_builder` やテストから得られます。

## snackbar、ダイアログ、テーマ: 素の Flutter に戻る

`Get.snackbar` が便利なのは、`BuildContext` を必要としないからです。その便利さこそが、テストできない理由でもあります。Riverpod の慣用的な答えは、UI が消費する状態のみのシグナルです。

```dart
// flutter_riverpod 3.3.1
@riverpod
class Toast extends _$Toast {
  @override
  String? build() => null;

  void show(String message) => state = message;
  void clear() => state = null;
}

class ToastListener extends ConsumerWidget {
  const ToastListener({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(toastProvider, (_, next) {
      if (next != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next)));
        ref.read(toastProvider.notifier).clear();
      }
    });
    return child;
  }
}
```

`Scaffold` の祖先を持つツリーの一部を `ToastListener` でラップしてください。これでどのコントローラーからも `BuildContext` に触れずに `ref.read(toastProvider.notifier).show('Saved')` を呼べるようになり、テストはオーバーレイを傍受する代わりにプロバイダーの状態をアサートします。

テーマも同様です。`Get.changeTheme` は `MaterialApp.router` が監視する `themeProvider` になります。ローカライズは `Get.locale` を最後に移行するまで使い続けるか、`flutter_localizations` と `localeProvider` に移すかのどちらかです。

## テストはより高速で明瞭になる

最大の見返りはテストにあります。GetX のコントローラーテストは通常 `Get.testMode = true` とシングルトンの注意深い後始末を必要とします。Riverpod のテストは `ProviderContainer` を作り、関心のあるプロバイダーだけを正確にオーバーライドし、最後に dispose します。

```dart
// flutter_test, flutter_riverpod 3.3.1
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('Counter increments after delay', () async {
    final container = ProviderContainer(overrides: const []);
    addTearDown(container.dispose);

    final notifier = container.read(counterProvider.notifier);
    expect(container.read(counterProvider).count, 0);

    final f = notifier.incrementAfterDelay();
    expect(container.read(counterProvider).busy, true);
    await f;
    expect(container.read(counterProvider).count, 1);
    expect(container.read(counterProvider).busy, false);
  });
}
```

プロバイダーをオーバーライドしてフェイクを注入すれば (`apiClientProvider.overrideWithValue(FakeApi())`)、ほとんどのケースでモックフレームワークが要らなくなります。Riverpod 3 ではリスナーは可視でないとき一時停止しますが、テストでは明示的にモデル化しない限りすべてのコンテナがデフォルトで「可視」なので、既存のテストスイートからは変更が見えません。

## 移行で必ず引っかかる落とし穴

**`autoDispose` 対シングルトン。** コード生成された `@riverpod` プロバイダーはデフォルトで auto-dispose です。`Get.put(permanent: true)` のコントローラーを変換した後、画面を離れると状態がリセットされることに気づいたら、プロバイダーに `@Riverpod(keepAlive: true)` を付けてください。意図的に行うこと。永続的な状態は待ち構えるメモリリークです。

**`initState` でのプロバイダーの読み取り。** よくある GetX パターンは `initState` 内の `final c = Get.find<MyController>()` です。Riverpod の同等品は `ConsumerStatefulWidget` の中で `initState` 内の `ref.read(myProvider.notifier)` ですが、`build` 内で `ref.watch` を読むのは問題ありません。`initState` で notifier を一度読んで保管しておくのは臭いです。なぜなら notifier の同一性は `ref.invalidate` 後に変わりうるからです。`ref.read` を呼び出し箇所で行うのを優先してください。

**ルート変更下のバックグラウンドタスク。** Riverpod 3 は不可視のウィジェットでリスナーを一時停止します。これは通常望ましい挙動ですが、以前 GetX の貪欲な `Obx` によって生かされていた処理のタイミングを変えます。ユーザーが別のタブにいる間もネットワークの更新を走らせ続けねばならない場合、その仕事を一時停止されたウィジェットに任せるのではなく、`keepAlive: true` の `AsyncNotifier` に渡してください。

**ホットリスタートはまず GetX 側を落とす。** デュアルライブラリ期間中、ホットリスタートは `Get.put` インスタンスをリセットしますが、`ProviderScope` がツリーの最上位にあれば Riverpod の状態は生き残ります。これは移行に本当に役立ちます。ホットリスタートして Riverpod が所有する状態が保持されるのを見て、まだ何を移すべきかを確認できます。

**削除後の `Obx` ビルドエラー。** ファイルから GetX の import を取り除いた瞬間、残った `Obx(...)` 呼び出しはランタイム警告ではなく、固いコンパイルエラーになります。コミット前にプロジェクトを `Obx(` と `GetBuilder<` で検索してください。コンパイラーが捕まえてはくれますが、grep を 1 度かけるだけでビルドサイクルを節約できます。

## 残りの Flutter パイプラインとの組み合わせ方

Flutter のタスクが移行だけということは稀です。[マルチバージョンの CI マトリクス](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) も走らせている場合は、`flutter_riverpod` と生成された `*.g.dart` ファイルの両方を明示的にピン留めし、Dart SDK のバンプが古いブランチを壊すボイラープレートを静かに再生成しないようにしてください。GetX のコントローラーに住んでいた CPU バウンドな処理 (パース、ハッシュ、大規模な reduce) はそもそも [Dart isolate](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) に置くべきで、`AsyncNotifier` への移行はその受け渡しを綺麗にしてくれます。loading 状態がすでに第一級だからです。Notifier がネイティブコードを呼ぶ必要があれば、[プラグインを書かずにプラットフォームチャネル経由で追加する](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) ことができ、テストでオーバーライドできるようにそのチャネルを独立したプロバイダーとして公開してください。そして移行が完了し、実機でデバッグが必要なビルドを出荷するときも、[Windows から iOS デバッグの実機ワークフロー](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) はそのまま適用できます。状態ライブラリの変更は observatory ポートの挙動には影響しません。

移行のための最短のメンタルモデル。GetX は人間工学のために正しさを犠牲にし、Riverpod は正しさのために人間工学を犠牲にします。アプリを書き直しているのではなく、その状態グラフを名前替えしスコープを再定義しているだけです。画面ごとに行い、すべての `Get.find` がなくなるまでデュアルライブラリ期間を維持し、ルーティングのステップを飛ばさないでください。最後の `package:get` の import が `pubspec.yaml` から消える頃には、コードベースは小さくなり、テストは恐れなくてもよい部分になっているでしょう。

## 参考リンク

- [Riverpod 3.0 移行ガイド](https://riverpod.dev/docs/3.0_migration)
- [pub.dev の flutter_riverpod](https://pub.dev/packages/flutter_riverpod)
- [pub.dev の riverpod_generator](https://pub.dev/packages/riverpod_generator)
- [pub.dev の go_router](https://pub.dev/packages/go_router)
- [Riverpod テストレシピ](https://riverpod.dev/docs/essentials/testing)
- [pub.dev の GetX パッケージ](https://pub.dev/packages/get)

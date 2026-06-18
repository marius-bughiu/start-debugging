---
title: "Flutter で FutureBuilder から Riverpod の AsyncNotifier へ移行する (flutter_riverpod 3.3.2)"
description: "実際の Flutter アプリで、インラインの FutureBuilder ウィジェットから Riverpod の AsyncNotifier へ段階的に移行する手順です。非同期処理を build の外へ移し、プロバイダーとして公開し、.when() や switch のパターンマッチングで描画し、リフレッシュとミューテーションのメソッドを追加します。Flutter 3.44、Dart 3.x、flutter_riverpod 3.3.2 で検証済みです。"
pubDate: 2026-06-18
updatedDate: 2026-06-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
lang: "ja"
translationOf: "2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-18
---

画面を `FutureBuilder` から Riverpod の `AsyncNotifier` へ移すのは、通常 1 画面あたり 30 分から 60 分の作業で、そのほとんどはコードを書く時間ではなく削除する時間です。何が変わるのか。これまで `build` の中で生成していた Future はプロバイダーへ移り、ウィジェットは `StatefulWidget` のボイラープレートを失い、手動の `setState` によるリトライロジックは `ref.invalidate` に置き換わります。同じデータを 2 つ目のウィジェットが必要とした瞬間、画面遷移をまたいでキャッシュしたくなったとき、あるいは `FutureBuilder` を所有するウィジェット以外の場所からリフレッシュをトリガーする必要があるときは、この移行を行う価値があります。ある画面が本当に他の誰も触らない使い捨ての Future を所有しているだけなら、`FutureBuilder` のままにしておきましょう。その場合、この移行は何のメリットももたらしません。

このガイドでは Flutter 3.44、Dart 3.x、`flutter_riverpod` 3.3.2 を使用します。コード生成のスニペットは `riverpod_annotation` 3.x と `riverpod_generator` 3.x を `build_runner` とともに使うことを前提としています。

## なぜ FutureBuilder から移行するのか

- **Future が再ビルドのたびに再生成されなくなります。** `future:` をインラインで構築する `FutureBuilder` は、親が再ビルドされるたびに非同期処理を再実行します。`AsyncNotifier` は一度だけビルドし、無効化するまで結果をキャッシュします。(今のところ `FutureBuilder` を使い続けるなら、その特定のバグの修正方法は [FutureBuilder に Future を再生成させない方法](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) で扱っています。)
- **データを共有できるようになります。** 同じプロバイダーをウォッチする 2 つのウィジェットは、2 回の別々のネットワーク呼び出しではなく、キャッシュにヒットします。
- **リフレッシュとミューテーションに正しい置き場所ができます。** プルトゥリフレッシュ、エラー時のリトライ、楽観的更新は、ウィジェット内での `setState` の曲芸ではなく、ノーティファイアのメソッドになります。
- **エラーが型付けされ、握りつぶされません。** `AsyncValue` は `loading`、`data`、`error` (スタックトレース付き) を、パターンマッチングできる第一級の状態として持ちます。

## 何が変わるのか

| 領域 | 移行前 (`FutureBuilder`) | 移行後 (`AsyncNotifier`) | 深刻度 |
| --- | --- | --- | --- |
| Future の置き場所 | `build` または `initState` で生成 | ノーティファイアの `build()` メソッド | 高 |
| ウィジェットの型 | 通常は `StatefulWidget` | `ConsumerWidget` (ステートレス) | 中 |
| ローディング/エラーの描画 | `snapshot.connectionState` + `snapshot.hasError` | `AsyncValue.when` または `switch` | 中 |
| リトライ | 再ビルド + Future の再生成 | `ref.invalidate(provider)` | 低 |
| ミューテーション | `await` 後の `setState` | メソッド + `AsyncValue.guard` | 中 |
| dispose 時のキャンセル | 手動の `mounted` チェック | `ref.onDispose` で自動 | 低 |

唯一の本当に深刻度の高い項目は Future の置き場所です。それ以外はすべて、Future を移すことから自然に従います。

## 事前チェックリスト

- `flutter --version` が 3.44 以降、Dart 3.x を報告すること。
- `flutter_riverpod: ^3.3.2` が `pubspec.yaml` にあること。コード生成を使いたい場合は、`riverpod_annotation: ^3.0.0` も追加し、`dev_dependencies` の下に `riverpod_generator: ^3.0.0` と `build_runner` を追加します。
- アプリのルートが `ProviderScope` でラップされていること。そうでなければ、それがステップゼロです。

```dart
// Flutter 3.44, flutter_riverpod 3.3.2
void main() {
  runApp(const ProviderScope(child: MyApp()));
}
```

- 最初に移行するウィジェットを 1 つ選びます。アプリ全体を 1 つのコミットで変換しないでください。進めながら各画面をスモークテストします。

## 出発点: インラインの FutureBuilder

これが、移行元となるパターンです。プロフィール画面がユーザーを取得し、3 つの状態を手動で描画します。そこに埋め込まれているバグは典型的なものです。Future が `build` の中で生成されるため、再ビルドのたびに `repo.fetchUser(userId)` が再実行されます。

```dart
// Flutter 3.44, Dart 3.x -- the BEFORE
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context) {
    final repo = UserRepository();
    return FutureBuilder<User>(
      future: repo.fetchUser(userId), // re-runs on every rebuild
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text('Failed: ${snapshot.error}'));
        }
        final user = snapshot.data!;
        return Text(user.name);
      },
    );
  }
}
```

## 移行手順

1. **プロバイダーを宣言します。** 非同期呼び出しをノーティファイアの中へ移します。書き方は 2 通りあります。どちらか 1 つを選び、コードベース全体で一貫させてください。

**コード生成スタイル (新規コードに推奨):**

```dart
// flutter_riverpod 3.3.2, riverpod_annotation 3.x
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'profile_controller.g.dart';

@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

`build` の `userId` パラメーターによって、これはファミリーになります。`profileControllerProvider(userId)` は id ごとに 1 つのキャッシュされたノーティファイアを返します。ジェネレーターを実行し、エラーなく `.g.dart` ファイルが生成されることを確認します。

```bash
# verify: the build completes and emits profile_controller.g.dart
dart run build_runner build --delete-conflicting-outputs
```

**手動スタイル (コード生成なし):**

```dart
// flutter_riverpod 3.3.2
final profileControllerProvider =
    AsyncNotifierProvider.family<ProfileController, User, String>(
  ProfileController.new,
);

class ProfileController extends FamilyAsyncNotifier<User, String> {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

どちらも、値が `AsyncValue<User>` となるプロバイダーを生成します。ノーティファイアの `build` は `userId` ごとに一度だけ実行され、結果は無効化されるまでキャッシュされます。もはや `UserRepository()` を手動で構築しないことに注意してください。テスト可能で共有できるよう、別のプロバイダー経由で注入します。

2. **ウィジェットを `ConsumerWidget` に変換します。** `StatefulWidget`/`StatelessWidget` は `ConsumerWidget` になり、`build` は `WidgetRef` を受け取ります。`ref.watch` でプロバイダーを読み取り、`AsyncValue` を描画します。

```dart
// flutter_riverpod 3.3.2 -- the AFTER
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(profileControllerProvider(userId));
    return userAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => Center(child: Text('Failed: $err')),
      data: (user) => Text(user.name),
    );
  }
}
```

確認: 画面をホットリスタートします。ちょうど一度だけ取得するはずです。画面を離れて戻っても、再取得しないはずです (何かがプロバイダーをマウントし続けている限り、キャッシュは生きています)。その一度だけ取得する挙動こそ、この移行の要点です。

3. **switch のパターンマッチングで描画します (任意ですが、よりすっきりします)。** Dart 3 のパターンマッチングは、チームによっては `.when()` より読みやすく、リフレッシュ中も古いデータを表示し続けられます。これらのパターンの詳しい扱いは [AsyncValue でローディングとエラーの状態を表示する](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) にありますが、要点は次のとおりです。

```dart
// Dart 3.x switch over AsyncValue
final userAsync = ref.watch(profileControllerProvider(userId));
return switch (userAsync) {
  AsyncData(:final value) => Text(value.name),
  AsyncError(:final error) => Text('Failed: $error'),
  _ => const Center(child: CircularProgressIndicator()),
};
```

確認: これは `non-exhaustive switch` の警告なしでコンパイルされます。`_` のキャッチオールが `AsyncLoading` を処理します。

4. **リトライを `ref.invalidate` に置き換えます。** 古いリトライ経路は、再ビルドによって Future を再生成していました。今やリトライは 1 行です。エラーのブランチにボタンを追加します。

```dart
// flutter_riverpod 3.3.2
error: (err, stack) => Center(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('Failed: $err'),
      ElevatedButton(
        onPressed: () => ref.invalidate(profileControllerProvider(userId)),
        child: const Text('Retry'),
      ),
    ],
  ),
),
```

`ref.invalidate` はキャッシュされた値を破棄して `build` を再実行し、`AsyncValue` を `loading` に戻してから `data` または `error` へと切り替えます。確認: エラーを強制し (ネットワークをオフにする)、ネットワークを戻した状態で Retry をタップし、loading から data へ遷移することを確認します。

5. **`AsyncValue.guard` でミューテーションを追加します。** これは `FutureBuilder` が決して持たなかった能力です。ユーザーを更新して結果を反映するには、ノーティファイアにメソッドを追加します。`AsyncValue.guard` は非同期呼び出しをラップし、スローされた例外をハンドルされないクラッシュではなく `AsyncError` にします。

```dart
// flutter_riverpod 3.3.2
@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
  }
}
```

ウィジェットからは、コールバックの中で `ref.read(...).rename(...)` で呼び出します (コールバックでは `watch` ではなく `read` を使います)。確認: リネームをトリガーし、UI が loading になってから新しい名前を表示するのを観察します。失敗するリネームをトリガーし、例外をスローするのではなくエラー状態が描画されることを確認します。

## 検証

画面を移行したあと、このチェックリストを実行します。

- `flutter analyze` が新しい警告を報告しないこと。コード生成を使った場合は、`dart run build_runner build` がクリーンに完了すること。
- 画面が初回の表示でちょうど一度だけ取得すること (リポジトリに print を追加するか、ネットワークタブを観察します)。
- 画面を離れて戻っても、無効化しない限り再取得しないこと。
- 強制した失敗に対してエラーのブランチが描画され、Retry で回復すること。
- `flutter test` が通ること。プロバイダーは簡単にテストできます。`ProviderContainer` で `userRepositoryProvider` をフェイクでオーバーライドし、`AsyncValue` をアサートします。

```dart
// flutter_test + flutter_riverpod 3.3.2
test('loads the user', () async {
  final container = ProviderContainer(overrides: [
    userRepositoryProvider.overrideWithValue(FakeUserRepository()),
  ]);
  addTearDown(container.dispose);

  final user = await container.read(profileControllerProvider('42').future);
  expect(user.name, 'Ada');
});
```

## ロールバック計画

この移行は画面ごとに可逆です。一度に 1 つのウィジェットずつ変換できるからです。1 つの画面をロールバックするには、`FutureBuilder` ウィジェットを復元し、そのプロバイダーを削除します。段階的に移行していれば、他の何もそれに依存していません。唯一の一方通行のドアは、多数の画面にまたがる古い `StatefulWidget` の配管を 1 つのコミットで削除することです。それはやめてください。各画面の移行をそれぞれのコミットに保てば、リバートは 1 行の `git revert` で済みます。

## 遭遇した落とし穴

**コールバックの中の `ref.watch` は何も有用に再ビルドしません。** `onPressed` ハンドラーでは `ref.read` を使います。`watch` は `build` のためのもので、コールバックで使うと間違ったタイミングでサブスクライブし、「ボタンを押しても画面がリフレッシュされない」という混乱のよくある原因になります。

**ファミリーのパラメーターは安定していなければなりません。** `profileControllerProvider(userId)` はキャッシュを `userId` でキー付けします。もし値の等しいキーの代わりに、新しく構築されたオブジェクト (新しい `User` インスタンスやマップ) を誤って渡すと、再ビルドのたびに新しいノーティファイアが生成され、キャッシュは決してヒットしません。プリミティブか、適切な `==` を持つ型を使ってください。

**`await` のあとに dispose された `ref`。** ミューテーションが `await` していて、その途中でプロバイダーが dispose された (ユーザーが画面を離れた) 場合、そのあとで `ref` に触れるとスローされます。Riverpod 3 はこれを明確に表面化します。修正方法と正確なメッセージは [「Cannot use ref after the widget was disposed」を修正する](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) にあります。長いミューテーションで `await` のあとにどうしても `ref` に触れる必要があるなら、`ref.mounted` でガードしてください。

**プロバイダーが早すぎるタイミングで dispose されます。** デフォルトでは、リスナーのないプロバイダーは dispose されます。画面を離れて戻ったときに望まない再取得が見られたら、それは auto-dispose が仕事をしているのです。`build` の中で `ref.keepAlive()` を使って意図的に生かし続けるか、その再取得を正しいキャッシュの挙動として受け入れます。

**これを `provider` パッケージの状態と混ぜないでください。** アプリの他の場所で依然としてレガシーの `provider` パッケージを使っているなら、それは別途移行してください。両者は共存しますが、メンタルモデルを曖昧にします。[provider から Riverpod への移行](/ja/2026/06/migrate-from-provider-to-riverpod-in-flutter/) がその道筋を扱っています。そして、あるウィジェットにとって `AsyncNotifier` が本当に正しい選択かどうかをまだ判断しているところなら、[FutureBuilder と Riverpod AsyncValue の判断ガイド](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) が線を引いています。

## 出典

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- 統一された `Ref` とノーティファイアの変更に関する公式 Riverpod 移行ガイド。
- [(Async)NotifierProvider](https://riverpod.dev/docs/providers/notifier_provider) -- 規範的な `AsyncNotifier` と `build()` の契約。
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- 3.0 の機能と破壊的変更の一覧。
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) -- バージョン 3.3.2 の確認。

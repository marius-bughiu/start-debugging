---
title: "Flutter で FutureBuilder から Riverpod の AsyncNotifier へ移行する (flutter_riverpod 3.3.2)"
description: "FutureBuilder を Riverpod 3 AsyncNotifier へ移行。検証済み手動 family、明示的なキャッシュ寿命と再試行、安全な更新処理を解説します。"
pubDate: 2026-06-18
updatedDate: 2026-11-02
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

複数のウィジェットで状態を共有したい場合や、更新処理をまとめたい場合は、`FutureBuilder` のリクエストを `AsyncNotifier` に移せます。移行は必須ではありません。単一ウィジェットが保持する Future には引き続き `FutureBuilder` が適しています。問題は `build()` のたびに新しいリクエストを作ることです。

この例は **flutter_riverpod 3.3.2** の Riverpod 3 手動 API を使い、**Flutter 3.44.8 / Dart 3.12.2** で確認しました。コード生成は使いません。2つの Dart ブロックは同じファイルに置きます。検証を再現するには `flutter_riverpod: 3.3.2` に固定してください。これは検証した版であり、最新版という意味ではありません。

## リクエストと更新処理をプロバイダーへ移す

`UserRepository` はアプリ側との契約です。既存 API クライアントで実装し、ルートの `ProviderScope` 内で `userRepositoryProvider` を override します。未設定を見落とさないよう、既定実装は意図的にエラーを投げます。テストではメモリ上の fake に差し替えます。

Riverpod 3 の手動 family notifier は `AsyncNotifier<User>` を継承し、ID をコンストラクターで受け取り、引数なしの `build()` を実装します。`FamilyAsyncNotifier<User, String>` は旧 API です。下の例では自動破棄を有効にし、自動再試行を無効にして、Retry ボタンで復旧を制御します。

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class User {
  const User(this.name);
  final String name;
}

abstract class UserRepository {
  Future<User> fetchUser(String id);
  Future<void> rename(String id, String name);
}

final userRepositoryProvider = Provider<UserRepository>(
  (ref) => throw UnimplementedError('Override with your repository'),
);

final profileControllerProvider =
    AsyncNotifierProvider.autoDispose.family<ProfileController, User, String>(
  ProfileController.new,
  retry: (retryCount, error) => null,
);

class ProfileController extends AsyncNotifier<User> {
  ProfileController(this.userId);
  final String userId;

  @override
  Future<User> build() {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    if (state.isLoading) return;
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncLoading();
    final next = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
    if (!ref.mounted) return;
    state = next;
  }
}
```

`AsyncValue.guard` は更新の失敗をエラー状態に変換します。await 後の `ref.mounted` は破棄済み notifier への書き込みを防ぎます。読み込み中の確認は、このメソッドからの同時 rename を抑えますが、トランザクションや HTTP キャンセルではありません。

## 共有状態を表示する

画面を次の `ConsumerWidget` に置き換えます。build 中は `ref.watch` で購読し、ボタンのコールバックでは `ref.read` または `ref.invalidate` を使います。`skipLoadingOnRefresh: false` により、以前のデータがあっても無効化後は読み込み表示になります。

```dart
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(profileControllerProvider(userId)).when(
      skipLoadingOnRefresh: false,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Column(
        children: [
          Text('Failed: $error'),
          ElevatedButton(
            onPressed: () => ref.invalidate(profileControllerProvider(userId)),
            child: const Text('Retry'),
          ),
        ],
      ),
      data: (user) => Column(
        children: [
          Text(user.name),
          ElevatedButton(
            onPressed: () => ref
                .read(profileControllerProvider(userId).notifier)
                .rename('Grace'),
            child: const Text('Rename'),
          ),
        ],
      ),
    );
  }
}
```

## 状態の保持期間を決める

- 同じ scope 内で同じ family キーを使うウィジェットは、存続中の状態を共有します。キーの等価性と `hashCode` は安定している必要があります。
- `.autoDispose` は最後の listener が離れた後の破棄を可能にします。破棄後に画面へ戻れば再取得します。依存関係の変化や無効化でも `build()` は再実行されます。
- 手動定義では自動破棄は明示的に有効化します。生成された `@riverpod` プロバイダーでは既定で有効です。両者の既定値は同じではありません。保持が必要な場合に限り `ref.keepAlive()` や明示的なキャッシュ方針を使います。
- Riverpod 3 は対象となる初期化失敗を既定で再試行します。この例は `retry: (_, _) => null` で無効にしています。実際のアプリに合う方針を選んでください。`AsyncValue.guard` は更新メソッドを自動再試行しません。
- `ref.onDispose` はフックであり、通信を自動キャンセルしません。必要なら HTTP クライアントのキャンセル・後始末処理と接続します。

`AsyncData` と `AsyncError` だけを分岐する switch では、更新中も古いデータが見えるとは限りません。表示方針を明示してください。`.when()` にも読み込み・refresh の設定があります。Pull-to-refresh では `ref.refresh(profileControllerProvider(userId).future)` を await すると、リクエスト完了に合わせて操作を終了できます。

## 移行を検証する

修正版コードは解析に加え、共有読み取り、無効化、破棄後の再取得、失敗と手動復旧、rename の成功・失敗、破棄後の更新完了を対象とする provider/widget テストに合格しました。fake リポジトリを使った検証であり、実際のネットワークサービスや認証は検証していません。アプリでも同等の確認を行ってください。

```bash
flutter analyze
flutter test
```

一画面ずつ移行します。戻す場合は保存した Future を使う実装へ復元し、不要なプロバイダーを削除します。build ごとに新しい Future を作らないようにしてください。

**2026年11月2日訂正:** Riverpod 2 の family API を置き換え、破棄と再試行の方針を明示しました。画面遷移時のキャッシュと通信キャンセルの説明を修正し、await 後のライフサイクル確認を追加しました。旧版のガイドを Riverpod 3 の資料として紹介するリンクは削除しました。

## 出典と関連記事

- [Flutter: FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Riverpod 3: migration](https://riverpod.dev/docs/3.0_migration)
- [Riverpod: families](https://riverpod.dev/docs/concepts2/family)
- [Riverpod: automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose)
- [Riverpod: automatic retry](https://riverpod.dev/docs/concepts2/retry)
- [Riverpod: request cancellation](https://riverpod.dev/docs/how_to/cancel)
- [flutter_riverpod 3.3.2](https://pub.dev/packages/flutter_riverpod/versions/3.3.2)

- [FutureBuilder / Future](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [AsyncValue](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Ref / dispose](/ja/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)
- [provider → Riverpod](/ja/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [FutureBuilder / Riverpod](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)

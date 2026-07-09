---
title: "Flutter で Riverpod 2.x から Riverpod 3.0 へ移行する"
description: "flutter_riverpod 2.x から 3.x への段階的なアップグレード手順です。パッケージを更新し、StateProvider などを legacy インポートへ移し、AutoDispose と Family の ref 型を廃止し、ProviderException のラップと自動リトライに対応し、StreamProvider のイベントを暗黙的に取りこぼす == による通知フィルタリングを修正します。Flutter 3.44、Dart 3.x、flutter_riverpod 3.3.2 で検証済みです。"
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ja"
translationOf: "2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-09
---

実際のアプリを `flutter_riverpod` 2.x から 3.x へアップグレードする作業は、たいてい半日仕事であり、その大半は機械的な検索と置換です。3.0 系は 2025 年 9 月にリリースされ、現在のリリースは 3.3.2（2026 年 6 月）です。このガイドは、そのバージョンを Flutter 3.44（stable、2026 年 5 月）および Dart 3.x で検証しています。実際に壊れる箇所は次のとおりです。`StateProvider`、`StateNotifierProvider`、`ChangeNotifierProvider` は `legacy.dart` インポートの背後へ移動し、すべての `Ref` サブタイプ（`FutureProviderRef`、`AutoDisposeNotifier`、`FamilyNotifier`）は 1 つの型に集約され、プロバイダーのエラーは `ProviderException` にラップされて出てくるようになり、プロバイダーは `==` で通知をフィルタリングするようになります。後ろの 2 つはコンパイルエラーではなく実行時に驚かされる類のものなので、該当セクションを注意深く読んでください。コードベースがすでにコード生成（`@riverpod`）を使っているなら、プロバイダー宣言を手書きしている場合よりも変更する箇所は少なくなります。

## そもそもなぜアップグレードするのか

Riverpod 2.x はまだ動作するので、移行する理由は具体的でなければなりません。

- **指数バックオフ付きの自動リトライ**が組み込まれました。不安定なネットワークで失敗した `FutureProvider` は、手動で `ref.invalidate` するまで失敗したままになる、ということがなくなります。
- **`Ref.mounted`** が、非自明なアプリがどれも抱えていた「await のあとにこのプロバイダーはまだ生きているか」を判定する手作りの mixin を置き換えます。完全なパターンについては [async ギャップのあとに Ref.mounted を確認する方法](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) を参照してください。
- **統一された単一の `Ref` 型**と、形状ごとに 1 つの `Notifier`。コンパイラの耐久テストのように読める `AutoDisposeFamilyAsyncNotifier` のような型名はもうありません。
- **オフライン永続化**と**ミューテーション**が実験的 API として導入され、フォーム送信の状態や再起動をまたいだキャッシュを自分で組み立てる必要がなくなります。

## 何が壊れるか

| 領域                        | 変更点                                                                              | 深刻度 |
| --------------------------- | ----------------------------------------------------------------------------------- | -------- |
| レガシープロバイダー          | `StateProvider`、`StateNotifierProvider`、`ChangeNotifierProvider` には `legacy.dart` が必要 | high     |
| Ref サブタイプ                | `FutureProviderRef`、`StreamProviderRef` などがすべて単一の `Ref` になる            | high     |
| AutoDispose / Family 型  | `AutoDisposeNotifier`、`FamilyNotifier` は削除。`Notifier` 上の修飾子を使う        | high     |
| エラー伝播           | 読み取りは元のエラーをラップした `ProviderException` を再スローする                       | high     |
| 通知フィルタリング      | すべてのプロバイダーがリスナーへ通知するかどうかを `==` で判定する                            | medium   |
| 自動リトライ            | 失敗したプロバイダーはデフォルトでバックオフ付きにリトライする                                      | medium   |
| `ProviderObserver`          | コールバックが単一の `ProviderObserverContext` を受け取る                                   | medium   |
| `AsyncValue.valueOrNull`    | `value` に改名。古いスローする `value` ゲッターは廃止                         | low      |

## 事前チェックリスト

プロバイダーに手を付ける前に。

1. すべてをコミットまたはスタッシュしておきます。この移行は多くのファイルに触れるので、レビューするためにクリーンな `git diff` が欲しいところです。
2. Dart SDK が 3.x であることを確認します。Riverpod 3.0 はそれを必須とします。`dart --version` を実行して確認してください。
3. コード生成を使っているなら、まず現在の 2.x のコードで `build_runner` がクリーンに走ることを確認します。ジェネレーターのエラーと移行のエラーを同時にデバッグしたくはないはずです。
4. `riverpod_lint` を使っているかどうかを確認します。これは lint ルールと、以下のステップのいくつかを自動化する `dart fix` の移行ヘルパーを同梱しているので、インストールしておくと手作業の編集を減らせます。

## ステップ 1: パッケージを更新する

`pubspec.yaml` 内のすべての Riverpod パッケージを一度に 3.x 系へ更新します。2.x と 3.x のパッケージが混在すると解決できません。

```yaml
# pubspec.yaml -- flutter_riverpod 3.3.2, Dart 3.x
dependencies:
  flutter_riverpod: ^3.3.2
  riverpod_annotation: ^3.3.2   # only if you use code-generation

dev_dependencies:
  riverpod_generator: ^3.3.2    # only if you use code-generation
  riverpod_lint: ^3.3.2
  custom_lint: ^0.8.0
  build_runner: ^2.4.0
```

そして解決します。

```bash
# Flutter 3.44
flutter pub get
```

**確認:** `flutter pub deps | grep riverpod` で、すべての Riverpod パッケージが 3.x バージョンになっていることを確認します。pub がバージョン競合を訴える場合、推移的依存関係のどれかがまだ `riverpod` 2.x を固定しています。`flutter pub deps` を実行して原因を特定してください。

## ステップ 2: まず自動修正を実行する

Riverpod 3.0 は `riverpod_lint` を通じて `dart fix` の移行ルールを同梱しています。手作業で何かをする前にこれを実行してください。退屈な機械的書き換え（`Ref` サブタイプの改名、`AutoDispose` プレフィックスの除去）を全ファイルにわたって一度に処理してくれるからです。

```bash
# preview the changes without writing them
dart fix --dry-run

# apply them
dart fix --apply
```

**確認:** `dart fix --dry-run` を再実行し、Riverpod 固有の修正がリストから消えていることを確認します。次に `git diff` で何が変更されたかを読みます。このツールは優秀ですが全知ではないので、残りのステップはツールが推測できない部分です。

## ステップ 3: レガシープロバイダーを legacy インポートの背後へ移す

`StateProvider`、`StateNotifierProvider`、`ChangeNotifierProvider` は依然として存在しますが、メインのインポート面がモダン API だけを公開するように、別のライブラリに置かれるようになりました。これらをメインパッケージからインポートすると「undefined name」エラーになります。

```dart
// Riverpod 3.x
// Add this import wherever you still use the legacy providers:
import 'package:flutter_riverpod/legacy.dart';

// StateProvider itself is unchanged in behaviour:
final counterProvider = StateProvider<int>((ref) => 0);
```

これは、ずっと無視できる非推奨警告ではなく、意図的な後押しです。長期的な方向性は、各 `StateProvider` を `Notifier` として、各 `StateNotifierProvider` を `Notifier` または `AsyncNotifier` として書き直すことであり、これは [provider パッケージからの移行](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) で行き着くのと同じ目標形状です。ただし、バージョン更新の際にその書き直しを行う必要はありません。インポートを追加し、グリーンにして、変換は後で行えばよいのです。

**確認:** アプリがコンパイルできること。`legacy.dart` を grep して、レガシープロバイダーを使うすべてのファイルにインポートがあること、そして必要がないのにインポートしているファイルがないこと（未使用インポートはリンターが指摘します）を確認します。

## ステップ 4: Ref サブタイプと Notifier のバリアントを集約する

2.x では、コード生成されたプロバイダーは `CounterRef` のような型付き ref を渡し、手書きのプロバイダーは `FutureProviderRef<T>`、`StreamProviderRef<T>` などを使いました。3.0 では単一の `Ref` になります。`dart fix` のパスがたいていこれを処理しますが、ツールがスキップした手書きの宣言は編集が必要です。

```dart
// Riverpod 2.x
int example(ExampleRef ref) => 0;

Future<User> user(UserRef ref) async => fetchUser();
```

```dart
// Riverpod 3.x -- one Ref type for everything
int example(Ref ref) => 0;

Future<User> user(Ref ref) async => fetchUser();
```

同じ統一がクラスベースの notifier にも及びます。`AutoDisposeNotifier`、`FamilyNotifier`、そしてその中間にある名前の組み合わせ爆発はなくなりました。同じ振る舞いは、基底の `Notifier` 上の修飾子で表現します。

```dart
// Riverpod 2.x
class TodosNotifier extends AutoDisposeAsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AutoDisposeAsyncNotifierProvider<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

```dart
// Riverpod 3.x -- autoDispose is a modifier, not a base class
class TodosNotifier extends AsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AsyncNotifierProvider.autoDispose<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

以前は `FamilyNotifier` に置かれていた family パラメーターは、通常の `build` 引数（コード生成）として、または `.family` 修飾子を通じて（手動）渡されるようになりました。`@riverpod` を使っているなら、ジェネレーターが結線を処理するので、再生成するだけです。

**確認（コード生成ユーザー）:** 生成されたファイルを削除して再ビルドします。

```bash
dart run build_runner build --delete-conflicting-outputs
```

ジェネレーターのエラーがゼロであること、そして再生成された `.g.dart` ファイルが古い型付き ref ではなく `Ref` を参照していることを確認します。

## ステップ 5: ProviderException のラップに対応する

これは、コンパイルチェックをすり抜けて実行時に壊れる可能性が最も高い変更です。3.0 では、プロバイダーの `build` がスローし、別のコードがそれを命令的に読み取ると、その読み取りは元の例外を再スローしません。それをラップした `ProviderException` を再スローします。元の型をキャッチしていた `on MyException catch` ブロックは、発火しなくなります。

```dart
// Riverpod 2.x -- this used to work
try {
  final user = await ref.read(userProvider.future);
} on NotFoundException catch (e) {
  showNotFound();
}
```

```dart
// Riverpod 3.x -- catch the wrapper, inspect .exception
try {
  final user = await ref.read(userProvider.future);
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    showNotFound();
  } else {
    rethrow;
  }
}
```

ラップされない経路は `AsyncValue` です。プロバイダーを `.when(error: ...)` でレンダリングしたり `AsyncError` をパターンマッチしたりすると、そこで得られるエラーはラッパーではなく元の例外です。したがって、状態をリアクティブに読み取る UI コードは影響を受けません。`try`/`catch` 内の命令的な `ref.read(...future)` だけが変更を必要とします。[Riverpod 3.0 の ProviderException](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) に関する専用の解説で、コーナーケースを扱っています。

**確認:** `try` ブロック内で `ref.read(` と `.future` が組み合わさっている箇所、およびドメイン例外を名指しする `catch` 節を grep します。プロバイダーをスローさせ、ハンドラーがまだ実行されることをアサートするテストを追加します。

## ステップ 6: == による通知フィルタリングを修正する

2.x では、プロバイダーの型ごとにリスナーへ通知するタイミングを判定するルールが異なっていました。3.0 ではすべてが `==` を使います。`Notifier` の状態についてはこれはたいてい問題ありませんが、`StreamProvider` と `StreamNotifier` では厳しく効いてきます。ストリームが `==` で等しいオブジェクト（たとえば、等価性をオーバーライドしていない可変クラスや、たまたま等しく比較される 2 つの値）を発行すると、2 回目の発行は重複として破棄されるようになります。

失敗の様態は、ストリームが明らかに発行しているのに更新が止まる UI です。修正は、発行される型が正しい等価性のセマンティクスを持つようにすることです。ドメインオブジェクトを発行するなら、それらに値等価性を与えます（`record`、Freezed クラス、または手書きの `==`/`hashCode`）。どちらを選ぶべきかについては [Dart の record と Freezed クラス](/2026/05/dart-records-vs-freezed-classes/) を参照してください。

```dart
// Riverpod 3.x -- two distinct ticks that are == would be collapsed.
// A record gives structural equality so each tick is treated as new.
Stream<({int count, DateTime at})> ticks(Ref ref) async* {
  var n = 0;
  await for (final _ in Stream.periodic(const Duration(seconds: 1))) {
    yield (count: n++, at: DateTime.now());
  }
}
```

等価性に関係なく本当にすべての発行を通したいなら、`StreamNotifier` 上の `updateShouldNotify` をオーバーライドして `true` を返すようにします。

**確認:** アプリを実行し、ストリームに支えられた任意のウィジェットを観察して、期待するすべての発行で更新され続けることを確認します。これはコンパイル時のシグナルがないので、手動のスモークテストが必要です。

## ステップ 7: 自動リトライについて判断する

失敗したプロバイダーは自動的にリトライするようになりました。初期遅延 200 ms から始まり、6.4 秒まで倍増していきます。ほとんどのネットワークに支えられたプロバイダーにとって、これはアップグレードです。しかし、失敗が恒久的なプロバイダー（バリデーションエラー、決して 200 にならない 404）がある場合、暗黙のリトライは呼び出しを無駄にし、数秒間にわたって UI 上のエラーを覆い隠してしまう可能性があります。

スコープでグローバルに、またはプロバイダーごとにオプトアウトします。

```dart
// Riverpod 3.x -- disable retry everywhere
ProviderScope(
  retry: (retryCount, error) => null, // null delay = do not retry
  child: MyApp(),
)
```

```dart
// Or keep it, but stop retrying non-transient errors
ProviderScope(
  retry: (retryCount, error) {
    if (error is NotFoundException) return null;
    if (retryCount >= 3) return null;
    return Duration(milliseconds: 200 * (1 << retryCount));
  },
  child: MyApp(),
)
```

**確認:** プロバイダーを 404 を返すエンドポイントに向け、サーバーを叩き続けないこと、あるいはリトライ述語が意図どおり短絡することを確認します。

## ステップ 8: ProviderObserver と valueOrNull の改名を更新する

カスタムの `ProviderObserver`（アナリティクス、ロギング）がある場合、そのコールバックのシグネチャが変わりました。コンテナ引数とプロバイダー引数が単一の `ProviderObserverContext` にマージされました。

```dart
// Riverpod 3.x
class LoggingObserver extends ProviderObserver {
  @override
  void didUpdateProvider(
    ProviderObserverContext context,
    Object? previousValue,
    Object? newValue,
  ) {
    debugPrint('${context.provider.name} -> $newValue');
  }
}
```

そして小さい方です。`AsyncValue.valueOrNull` は `value` に改名されました。古い `value` ゲッター（ロード中／エラー時にスローしていたもの）はなくなりました。スローする振る舞いに依存していたなら、代わりに `AsyncData` ケースをパターンマッチしてください。

**確認:** アナライザーがすべての `valueOrNull` 呼び出し箇所を指摘します。ステップ 2 の `dart fix` パスがたいていそれらを書き換えますが、残っていないことを確認します。

## 検証: 完全なスモークテスト

すべてのステップのあと、チェックリストを端から端まで実行します。

- `flutter pub get` が、すべての Riverpod パッケージを 3.x にして解決する。
- `dart run build_runner build --delete-conflicting-outputs` がエラーゼロを生成する（コード生成ユーザー）。
- `flutter analyze` がクリーンで、`AutoDispose`／`valueOrNull`／型付き ref の参照が残っていない。
- `flutter test` が通る。`ProviderException` の処理とストリーム発行のために追加した新しいテストを含む。
- 手動で試す: ストリームに支えられた画面、エラー画面、プロバイダーの失敗を引き起こす画面を操作し、リトライ、ラップ、`==` フィルタリングがすべて期待どおりに振る舞うことを確認する。

## ロールバック計画

この移行は、実際には一方通行の扉です。`import 'package:flutter_riverpod/legacy.dart'` を書き、単一の `Ref` 型を採用した瞬間、元に戻すにはすべてのファイルを取り消すことになります。クリーンなロールバックはコードではなく `git` です。移行全体をブランチ上で行い、2.x のブランチには手を付けず、スモークテストが通ってからのみマージします。中途半端な移行をしてそれを出荷してはいけません。一部のファイルが 3.x のセマンティクスで、一部が 2.x の前提（特にエラーラップまわり）になっているコードベースは、どちらのバージョン単体よりも悪いものです。

## 遭遇したハマりどころ

- **`==` フィルタリングは、問題が起きるまで見えません。** 同じコードがその場で変更するリストに支えられた `StreamProvider<List<Item>>` は、同じリストのインスタンスを 2 回発行し、3.0 は 2 回目の通知を破棄します。毎回、新しいリスト（または値等価な型）を発行してください。
- **`catch` 内の `ref.read(provider.future)` は厄介なものです。** これは問題なくコンパイルされ、本番でプロバイダーが実際にエラーを起こしたときにだけ姿を現します。先回りして探しておいてください。
- **`dart fix` は文字列型や動的に組み立てられたプロバイダー参照には触れません。** アナライザーが静的に見えないものは、手作業で編集します。
- **`riverpod_generator` を歩調を合わせて更新せずに `riverpod` を更新してはいけません。** 3.x のランタイムに 2.x のジェネレーターだと、古い `Ref` サブタイプを参照するコードが生成され、分かりにくい形でコンパイルに失敗します。

## 関連記事

- [Flutter で provider から Riverpod へ移行する](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [Flutter Riverpod 3 で async ギャップのあとに Ref.mounted を確認する方法](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [修正: Riverpod 3.0 が元のエラーの代わりに ProviderException をスローする](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)
- [2026 年の Flutter 状態管理における provider・Riverpod・Bloc の比較](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Flutter で FutureBuilder から Riverpod AsyncNotifier へ移行する](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## 出典

- [Migrating from 2.0 to 3.0, Riverpod docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0, Riverpod docs](https://riverpod.dev/docs/whats_new)
- [riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod)
</content>
</invoke>

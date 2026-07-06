---
title: "解決策: Riverpod 3.0 が元のエラーではなく ProviderException をスローする"
description: "Riverpod 3.0 はプロバイダーの読み取り中にスローされたエラーを ProviderException でラップします。その型をキャッチして e.exception を読めば元のエラーを取り戻せます。あるいは、ラップされない AsyncValue.error を使いましょう。"
pubDate: 2026-07-06
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ja"
translationOf: "2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error"
translatedBy: "claude"
translationDate: 2026-07-06
---

Riverpod 3.0 へのアップグレード後に `on NotFoundException catch` が発火しなくなったのは、失敗したプロバイダーの読み取りが元の例外を再スローしなくなったからです。今は、それをラップした `ProviderException` を再スローします。壊れた `try`/`catch` を直すには、`ProviderException` をキャッチして `e.exception` から本来のエラーを確認するか、意図的にラップされないままになっている `AsyncValue.error` に切り替えます。これは `flutter_riverpod` 3.x（3.0 系は 2025 年 9 月にリリース、現在のリリースは 2026 年 6 月の 3.3.2）、Flutter 3.44、Dart 3.x でテスト済みです。

このアップグレードで新たな障害が発生したわけではありません。プロバイダーは、これまでと同じ例外を今も変わらずスローしています。変わったのは、別のコードがそのプロバイダーを命令的に読み取ったときに、反対側から返ってくる型です。

## 文脈の中でのこのエラー

`build` がドメイン例外をスローするプロバイダーと、それを `try`/`catch` の中で読み取る呼び出し側があるとします。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
try {
  final user = await ref.read(userProvider.future);
  showProfile(user);
} on NotFoundException catch (e) {
  showNotFound(e.id); // never runs on Riverpod 3.0
}
```

Riverpod 2.x では、これが `NotFoundException` を直接キャッチしていました。3.0 では `on NotFoundException` 句がスキップされ、より広い `catch` がなければ、例外はキャッチされずに伝播します。実際のランタイム型をログ出力すると、次のように表示されます。

```
Unhandled exception:
ProviderException: An exception/error was thrown while building UserProvider.
  <original NotFoundException and its stack trace nested here>
```

`NotFoundException` は依然としてその中にあります。今やそれはスローされる対象そのものではなく、`ProviderException` の中に同乗している存在なのです。

## なぜ Riverpod 3.0 はエラーをラップするのか

プロバイダーがエラー状態になる理由は大きく異なる 2 つがあり、Riverpod 2.x はエラーをキャッチした時点でその 2 つを区別できませんでした。

1 つ目の理由は **このプロバイダー自身が失敗した** 場合です。自分の `build` がスローしました。2 つ目の理由は **このプロバイダーは正常だが、依存しているプロバイダーが失敗した** 場合で、エラーがグラフを下流へ伝播したものです。`dashboardProvider` が `userProvider` を watch し、それが `authProvider` を watch するような依存チェーンでは、`authProvider` の例外があらゆる下流の読み取りに現れます。3 つすべてが生の `AuthException` を再スローしていたら、`dashboardProvider` 周りの `catch` は「ダッシュボード自体が壊れた」のか「3 階層上の何かが壊れてその反響を見ているだけ」なのかを区別できません。

Riverpod 3.0 はこれをラップによって解決します。値を計算できなかったプロバイダーを読み取ると、エラーは **どのプロバイダー** がスローしたかを記録する `ProviderException` に格納され、元のエラーとそのスタックトレースを一緒に運びます。このラッパーは、伝播したプロバイダー障害を見ているというシグナルであり、`.exception` プロパティが本来のエラーに戻るための脱出口です。この挙動は [Riverpod 3.0 マイグレーションガイド](https://riverpod.dev/docs/3.0_migration) で説明されており、[riverpod issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) で追跡されています。

ここには知っておく価値のある小さな歴史があります。初期の Riverpod（2.0 より前）も `ProviderException` でラップしていましたが、`2.0.0-dev.1` でラップを削除して生の例外を再スローする方式に切り替え、`3.0.0-dev.16` で意図的にラッパーを復活させました。数年前に `ProviderException` が消えたのを覚えているなら、それは記憶違いではありません。3.0 が意図的にそれを再導入したのです。

## 最小再現

ファイルは 2 つ。スローするプロバイダーと、それを命令的に読み取るウィジェットです。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- reproduces the wrap.
import 'package:flutter_riverpod/flutter_riverpod.dart';

class NotFoundException implements Exception {
  const NotFoundException(this.id);
  final String id;
}

final userProvider = FutureProvider.autoDispose<User>((ref) async {
  final user = await ref.read(apiProvider).findUser('42');
  if (user == null) throw const NotFoundException('42');
  return user;
});
```

```dart
// The caller. On 2.x this printed "not found: 42".
// On 3.0 nothing prints and the ProviderException escapes.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on NotFoundException catch (e) {
    debugPrint('not found: ${e.id}');
  }
}
```

ユーザーが存在しないときに `load` を実行します。3.0 では、スローされるオブジェクトが `NotFoundException` ではなく `ProviderException` であるため、`on NotFoundException` 句はマッチしません。

## 修正方法、詳細

プロバイダーをどう消費しているかに合わせてアプローチを選びます。優先順位順です。

### 1. ProviderException をキャッチして e.exception で分岐する

プロバイダーを命令的に読み取る必要がある場合（イベントハンドラー内、ミューテーション内、コールバック内の `ref.read`）は、ラッパーをキャッチして `.exception` から元のエラーを取り出します。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- the direct fix.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on ProviderException catch (e) {
    switch (e.exception) {
      case NotFoundException(:final id):
        debugPrint('not found: $id');
      case SocketException():
        debugPrint('offline');
      default:
        rethrow; // do not swallow errors you did not plan for
    }
  }
}
```

`e.exception` はあなたがスローした元のオブジェクトなので、Dart のパターン `switch` で分岐させると読みやすく、フィールドの束縛（`:final id`）も同じ行でできます。予期しないエラーが黙って握りつぶされないように、常に `default: rethrow` を残しておきましょう。rethrow のない裸の `on ProviderException catch` は、列挙し忘れた将来のあらゆるエラー型を握りつぶしてしまいます。

パターンよりも `is` チェックが好みなら、等価な書き方は次のとおりです。

```dart
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    final id = (e.exception as NotFoundException).id;
    debugPrint('not found: $id');
  } else {
    rethrow;
  }
}
```

### 2. ラップされない AsyncValue を通してエラーを読む

コードがウィジェット内にある場合は、これがより良い修正です。慣用的な Riverpod の形でもあるからです。`AsyncValue.error` は、ラッパーではなく **元の** 例外を運びます。ラップが起きるのは命令的な再スローの経路（`ref.read`/`ref.watch` がスローするとき）だけであり、プロバイダーを watch して得られるリアクティブな `AsyncValue` はそのまま手つかずです。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- no ProviderException here.
class UserView extends ConsumerWidget {
  const UserView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(userProvider);
    return switch (async) {
      AsyncData(:final value) => ProfileCard(value),
      AsyncError(:final error) when error is NotFoundException =>
        NotFoundCard(error.id), // error is the raw NotFoundException
      AsyncError(:final error) => ErrorCard('$error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

`error is NotFoundException` が直接マッチしている点に注目してください。`AsyncValue.error` はそもそも `ProviderException` を保持していないので、アンラップは不要です。どのみちローディングとエラーの UI を描画するのであれば、命令的な `try`/`catch` よりもこちらを選びましょう。同じパターンは [AsyncValue でローディングとエラーの状態を表示する](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) の土台にもなっています。

### 3. ref.listen の onError でエラーを処理する（これもラップされない）

プロバイダーの失敗によって起こす副作用（スナックバー、ナビゲーション、アナリティクス）については、`ref.listen` の `onError` コールバックも生のエラーを受け取ります。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ref.listen<AsyncValue<User>>(userProvider, (prev, next) {}, onError: (error, stack) {
  // error is the original NotFoundException, not a ProviderException.
  if (error is NotFoundException) showSnack('User ${error.id} is gone');
});
```

## どの API がラップし、どの API がラップしないか

頭に入れておくと最も役立つ 1 枚の表です。ラッパーが現れるのは、プロバイダーがあなたのコードへ命令的に **再スロー** したときだけです。

`ProviderException` でラップされる（`.exception` を読む）:

- `p` のビルドが失敗した場合の `ref.read(p.future)`。
- スローした同期プロバイダーに対する `ref.watch(p)` で、その読み取りが再スローする場合。
- テスト内の `await container.read(p.future)`。

ラップされない（元のエラーを直接受け取る）:

- `ref.watch(asyncProvider)` からの `AsyncValue.error`。`value.error is MyException` をチェックします。
- `ref.listen(p, ..., onError: (e, s) => ...)`。`e` は生のエラーです。
- `ProviderObserver.providerDidFail`（およびオブザーバーのフック全般）。オブザーバーは加工されていないエラーとスタックを見ます。

処理がウィジェットの build 内で `AsyncValue` を通して行われている場合、あるいはリスナーやオブザーバーの中にある場合は、おそらく何も変える必要はありません。マイグレーションの痛みは、`ref.read(...future)` 周りの命令的な `try`/`catch` に集中しています。

## 落とし穴とバージョンの罠

**一部の初期 3.0 ビルドでは ProviderException を import できません。** [Issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) は、ドキュメントがラップを説明していた一方で、ビルドが `StateError` をスローし、`ProviderException` がまだエクスポートされていなかった期間を記録しています。`on ProviderException` がコンパイルできない、あるいは `StateError` をキャッチしている場合は、影響を受けるプレリリース版を使っています。型がエクスポートされ、挙動がドキュメントと一致する現在の安定版（`flutter_riverpod` 3.3.2 以降）にアップグレードしてください。それを回避するために恒久的な `on StateError` キャッチを書いてはいけません。更新すると再び壊れます。

**自分のエラーマッピングで二重にラップしないこと。** すべてをキャッチして正規化した `AppException` を再スローするインターセプターがあるなら、まず `ProviderException` をアンラップするようにしてください。さもないと、次の読み取りで `ProviderException` を `AppException` の中に、それをさらに別の `ProviderException` の中に、と入れ子にしてしまいます。境界でアンラップしましょう。`final real = e is ProviderException ? e.exception : e;`。

**リトライはラッパーを無視します。** Riverpod 3.0 の自動リトライ（指数バックオフ、200ms から 6.4s の上限まで倍増）は、本物のプロバイダービルド失敗はリトライしますが、依存先から単に伝播しただけの `ProviderException` はリトライしません。これにより、失敗した末端プロバイダーが、あらゆる下流プロバイダーにわたってリトライの嵐を引き起こすのを防いでいます。これは設定するものではありません。キャッチして再スローされた `ProviderException` は「すでに考慮済み」として扱われる、とだけ知っておいてください。

**ラッパーは async ギャップのガードではありません。** `ProviderException` をキャッチするのはプロバイダーが *失敗する* ことへの対処であり、await の途中でプロバイダーが *破棄される* ことには何もしません。それらは別のクラッシュです。await の後に `UnmountedRefException` も見られる場合、それはこれではなく [ref.mounted の問題](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) であり、キャッチではなく `if (!ref.mounted) return;` のガードが必要です。

**`on ProviderException` の中の `rethrow` は、内側のエラーではなくラッパーを再スローします。** `default` ブランチが `rethrow` を行うと、スタックの上位にいる呼び出し側は依然として `ProviderException` を見ます。それはたいてい望んだ動作です（出所が保持されます）が、外側の層が生のドメイン例外を期待している場合は、内側のものを明示的に再スローしてください。`Error.throwWithStackTrace(e.exception, e.stackTrace)`。

## 2.x から 3.0 へのアップグレードにおける位置づけ

これは、より大きな 3.0 マイグレーションの中の 1 項目にすぎず、`Ref.mounted` のライフサイクル変更や、統一された `Notifier` クラスへの移行と並ぶものです。今アップグレードをしているなら、`try` でラップされ、型付きの `on SomeException catch` を伴う `ref.read(` の呼び出しと、`catch` ブロック内の `.future` 読み取りをコードベースから grep してください。それらが、静かにマッチしなくなった呼び出し箇所です。`AsyncValue` を描画するウィジェットコードは安全です。Notifier が所有するライフサイクルとエラーセマンティクスが現代のデフォルトである理由の全体像については、[2026 年の Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) を参照してください。まだ古い `provider` パッケージを使っているなら、[provider から Riverpod への移行](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) が、これらに直面する前の移行をカバーしています。

これを整理し続けるためのメンタルモデル。`ProviderException` は「グラフ内のプロバイダーが失敗し、それをあなたが命令的に読み取った」という意味です。本当の原因を求めて `.exception` に手を伸ばすか、あるいはより良い方法として、ラップがまったく起きない `AsyncValue` を通じて失敗をリアクティブに消費しましょう。[ネットワークエラーを適切に処理する](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) のと同じ規律がここにも当てはまります。呼び出し箇所ごとに、値に反応しているのか、スローされた失敗に反応しているのかを判断し、期待する形でエラーを渡してくれる API を選びましょう。

## 関連記事

- [Flutter Riverpod 3 で async ギャップの後に Ref.mounted をチェックする方法](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)：アップグレード後にのみ表面化するもう 1 つの Riverpod 3.0 エラーで、スローの経路ではなく async ギャップの経路で起きます。
- [Flutter Riverpod で AsyncValue を使ってローディングとエラーの状態を表示する方法](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)：命令的な try/catch に代わるリアクティブな手段で、ラップの影響を受けません。
- [解決策: Flutter Riverpod でウィジェットが破棄された後に "ref" を使用できない](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)：これと混同されがちな別の Riverpod クラッシュです。
- [2026 年の Flutter 状態管理における Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)：Riverpod のエラーとライフサイクルのモデルが現在のデフォルトである理由をカバーします。
- [Flutter で provider から Riverpod へ移行する](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)：まだレガシーパッケージを使っているなら、これがこの前のステップです。

## 出典

- [2.0 から 3.0 への移行](https://riverpod.dev/docs/3.0_migration)：プロバイダーの読み取り失敗が `ProviderException` として再スローされること、および `e.exception` のキャッチパターンに関する公式の記述。
- [Riverpod 3.0 の新機能](https://riverpod.dev/docs/whats_new)：ラップの根拠（プロバイダー自身の失敗と、失敗したプロバイダーへの依存の区別）、および `ProviderException` を無視するリトライの挙動。
- [rrousselGit/riverpod issue 4320](https://github.com/rrousselGit/riverpod/issues/4320)：`StateError` がスローされ `ProviderException` を import できなかった初期 3.0 の不一致。
- [riverpod パッケージの changelog](https://pub.dev/packages/riverpod/changelog)：その歴史。`2.0.0-dev.1` がラッパーを削除し、`3.0.0-dev.16` がそれを再導入した。現在の安定版は 3.3.2（2026 年 6 月）。

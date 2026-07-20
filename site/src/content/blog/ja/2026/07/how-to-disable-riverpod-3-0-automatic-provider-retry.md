---
title: "Riverpod 3.0 の自動プロバイダーリトライを無効化する方法"
description: "Riverpod 3.0 はデフォルトで失敗したプロバイダーを最大 10 回リトライします。null を返す retry 関数を ProviderScope、ProviderContainer、または個々のプロバイダーに渡すことで、無効化したり回数を制限したりできます。"
pubDate: 2026-07-20
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "async"
lang: "ja"
translationOf: "2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry"
translatedBy: "claude"
translationDate: 2026-07-20
---

Riverpod 3.0 は自動リトライを追加しました。プロバイダーがビルド中に例外をスローすると、Riverpod は 200ms から始まって 6.4 秒まで倍々に増えていく指数バックオフで、最大 10 回まで黙ってリトライします。これをオフにするには、`null` を返す `retry` コールバックを渡します。`ProviderScope` や `ProviderContainer` でグローバルに設定することも、プロバイダーのコンストラクターや `@Riverpod` アノテーションでプロバイダーごとに設定することもできます。本記事は `flutter_riverpod` 3.x（3.0 系列は 2025 年 9 月にリリースされ、現在のリリースは 2026 年 6 月の 3.3.2 です）、Flutter 3.44、Dart 3.x で検証しています。

とにかくどこでも消し去りたいだけなら、次の一行です。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) => null, // never retry
  child: MyApp(),
)
```

本記事のそれ以外の内容は、なぜこのリトライが存在するのか、デフォルトが実際にあなたを助けてくれるのはどんなときか、そして完全に殺してしまう代わりにどう制限するか、という話です。

## かつては一度しか失敗しなかったプロバイダーがなぜ十回失敗するのか

Riverpod 2.x では、`build` が例外をスローしたプロバイダーは直ちに `AsyncError` に移行し、何かがそれを無効化するまでその状態にとどまりました。1 回の失敗、1 つのエラー状態。予測可能でした。

Riverpod 3.0 はそのデフォルトを変更しました。その理由は理にかなっています。プロバイダーの失敗の多くは一時的なものです。HTTP エンドポイントを呼ぶ `FutureProvider` が失敗するのは、コードが間違っているからではなく、ネットワークが一瞬途切れたからです。バックオフを伴うリトライは、手動でリフレッシュすればクリアできたはずのエラー画面に居座る代わりに、UI が自力で回復することを意味します。公式ドキュメントはこのデフォルトを、「200ms から 6.4 秒まで増えていく指数バックオフで、最大 10 回まで」リトライすると説明しています。

問題は、この挙動が実際に噛みついてくるまで見えないことです。決定論的に失敗するプロバイダー、たとえば不正な形式のレスポンスをパースしたり、決して 200 にはならない 404 に当たったりするプロバイダーは、エラー状態に落ち着くまでに 10 回すべての試行を消費するようになります。それらの試行の間、ローディングスピナーは回り続け、ログは同じスタックトレースで 10 回埋め尽くされ、`build` 内のあらゆる副作用（アナリティクスイベント、ログ行、カウンターのインクリメント）は 1 回ではなく 10 回発火します。テストではさらに悪化します。速く失敗すべきプロバイダーが、リトライスケジュールが再生される間ハングし、テストがタイムアウトするのです。

## リトライストームを再現する

この挙動を示す最小のプロバイダーがこちらです。無条件にスローし、`build` が実行されるたびにログを出力します。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';

int _attempts = 0;

final brokenProvider = FutureProvider<int>((ref) async {
  _attempts++;
  print('build attempt #$_attempts');
  throw StateError('this will never succeed');
});
```

ウィジェットから監視します。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
class Screen extends ConsumerWidget {
  const Screen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(brokenProvider);
    return value.when(
      data: (n) => Text('$n'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('failed: $e'),
    );
  }
}
```

Riverpod 2.x ではコンソールは `build attempt #1` を 1 回出力し、ウィジェットは即座にエラーを表示します。Riverpod 3.0 ではコンソールはおよそ 13 秒にわたって（200ms + 400ms + 800ms + ... 最大 6.4 秒まで）散らばった 10 回の試行を出力し、その間ずっとスピナーが表示されたままで、最後にようやくエラーがレンダリングされます。「リクエストが失敗した」と「ユーザーがエラーを目にする」の間のこの 13 秒のギャップこそ、ほとんどのチームが最初に遭遇する驚きです。

## リトライコールバックと、null を返すとなぜ無効化されるのか

Riverpod 3.0 のすべてのリトライフックは同じ形をしています。現在のリトライ回数とエラーを受け取り、`Duration?` を返します。その時間だけ待って再試行するには duration を返し、諦めてエラーを表面化するには `null` を返します。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? myRetry(int retryCount, Object error) {
  if (retryCount >= 5) return null;                       // cap attempts
  if (error is ProviderException) return null;            // don't retry wrapped deps
  return Duration(milliseconds: 200 * (1 << retryCount)); // 200ms, 400ms, 800ms...
}
```

`1 << retryCount` は単に `2^retryCount` なので、これは組み込みの指数カーブを再現します。リトライを完全に無効化するには、関数全体が引数を無視して常に `null` を返す一行に収束します。

### アプリ全体でオフにする

`ProviderScope` は、Flutter アプリでプロバイダーの状態をホストするウィジェットです。これに `retry` を与えると、その下のすべてのプロバイダーは、オーバーライドしない限りそのポリシーを継承します。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
void main() {
  runApp(
    ProviderScope(
      retry: (retryCount, error) => null,
      child: const MyApp(),
    ),
  );
}
```

純粋な Dart や、コンテナを手動でビルドするあらゆる場所では、同じパラメーターが `ProviderContainer` にあります。

```dart
// Dart 3.x, riverpod 3.x
final container = ProviderContainer(
  retry: (retryCount, error) => null,
);
```

### 一つのプロバイダーだけオフにする

グローバルオフは大雑把な道具です。通常は、リトライが役立つ 2 つのネットワークプロバイダーではリトライを有効にし、ローカル設定をパースしてバグによってのみ失敗しうるプロバイダーではオフにしたいはずです。すべてのプロバイダーコンストラクターは独自の `retry` パラメーターを取り、プロバイダーごとの値はスコープレベルの値に優先します。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final configProvider = FutureProvider<AppConfig>(
  (ref) async => AppConfig.fromAsset(await rootBundle.loadString('config.json')),
  retry: (retryCount, error) => null, // parsing bugs won't fix themselves
);
```

同じパラメーターはクラスベースのプロバイダーにも存在します。`NotifierProvider` や `AsyncNotifierProvider` では、コンストラクターの tear-off の隣に置かれます。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final todoListProvider = NotifierProvider<TodoList, List<Todo>>(
  TodoList.new,
  retry: (retryCount, error) => null,
);
```

### コード生成されたプロバイダーでオフにする

`riverpod_generator` を使う場合、アノテーションが `retry` 引数を運びます。名前付き関数を指すようにすれば、生成されたプロバイダーがそれを拾います。

```dart
// Flutter 3.44, Dart 3.x, riverpod_annotation 3.x
Duration? noRetry(int retryCount, Object error) => null;

@Riverpod(retry: noRetry)
Future<int> counter(Ref ref) async {
  throw StateError('fails once, stays failed');
}
```

アノテーションを変更したら `dart run build_runner build` を実行します。生成された `counterProvider` はノーリトライポリシーを運ぶようになり、生成ファイルには一切触れません。

## デフォルトがすでにスキップしているもの

リトライをグローバルに無効化する前に、デフォルトが「すべてを 10 回リトライする」ほど攻撃的ではないことを知っておいてください。2 つのカテゴリが最初から除外されています。

`Error`（`Exception` に対して）は決してリトライされません。Dart において、`Error` はプログラミングミスを示します。アサーション失敗、null に対する null チェック、不正なキャストなどです。これらは待っても回復しないので、Riverpod は直ちに表面化します。プロバイダーが `StateError` や `TypeError` をスローする場合、デフォルトのリトライはまったく作動しません。上の `brokenProvider` は `StateError` をスローしますが、これは `Error` のサブタイプなので、厳密に読めば直ちに表面化するはずです。コンソールで完全な 10 回試行のストームを観察したい場合は、素の `Exception` に置き換えてください。

`ProviderException` もスキップされます。プロバイダー A がプロバイダー B を読み、B が失敗した場合、Riverpod は A に到達する前に B の失敗を `ProviderException` でラップします。A 自体は問題ないので A をリトライしても無意味です。回復が必要なのは B です。デフォルトのリトライはこのラッパーを認識してリトライせず、依存チェーン内のすべてのプロバイダーが独自のリトライスケジュールを走らせるようなカスケードを回避します。ラップする型がなぜ重要なのか疑問に思ったことがあるなら、それは [Riverpod 3.0 が元のエラーの代わりに ProviderException をスローする](/ja/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)ときに壊れた `try`/`catch` の背後にあるのと同じ `ProviderException` です。

つまり実際には「リトライを無効化する」とは「回復可能な `Exception` のリトライをやめる」ことを意味します。エラーと依存関係の失敗はすでに直ちに表面化していたのです。

## リトライを殺す代わりに制限する

リトライを無効化するのは、ローカルデータを読み込んだり、アセットをパースしたり、失敗がしゃっくりではなくバグを意味するあらゆる操作を行うプロバイダーにとって正しい判断です。しかし本当に不安定な I/O については、制限されたリトライは無しよりも良いものです。パターンはこうです。試行回数を低く抑え、恒久的だとわかっているエラーはスキップし、短いバックオフを保つ。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? networkRetry(int retryCount, Object error) {
  // Give up after 3 tries.
  if (retryCount >= 3) return null;
  // A 404 will not become a 200 by waiting.
  if (error is NotFoundException) return null;
  // Otherwise back off: 300ms, 600ms, 1.2s.
  return Duration(milliseconds: 300 * (1 << retryCount));
}

final userProvider = FutureProvider<User>(
  (ref) => api.fetchUser(),
  retry: networkRetry,
);
```

約 2 秒にわたる 3 回の試行は、ユーザーを 13 秒間スピナーに見つめさせることなく、一時的な失敗を乗り切るのに通常は十分です。デフォルトの 10 回試行は、応答性よりも回復力を重視して調整されています。ほとんどのアプリはユーザー向けのプロバイダーについては逆のトレードオフを求めます。

## すべてのテストでリトライを無効化する

これはほとんどのチームが忘れる変更で、最も混乱を招く症状を生みます。かつてエラー状態をアサートしていたテストがタイムアウトするようになるのです。通常の方法で作成された `ProviderContainer` はデフォルトのリトライを継承するので、あなたが失敗させ*たい*プロバイダーは、エラーに対する `expect` が実行される前に 13 秒間リトライに費やします。

Riverpod 3.0 は、テスト用に自動破棄を追加するコンストラクター `ProviderContainer.test` を提供しており、これにノーオペレーションのリトライを渡すべきです。

```dart
// Dart 3.x, riverpod 3.x, flutter_test
import 'package:flutter_test/flutter_test.dart';
import 'package:riverpod/riverpod.dart';

void main() {
  test('brokenProvider surfaces its error immediately', () async {
    final container = ProviderContainer.test(
      retry: (retryCount, error) => null,
    );

    await expectLater(
      container.read(brokenProvider.future),
      throwsA(isA<StateError>()),
    );
  });
}
```

`retry` のオーバーライドがなければ、このテストは最終的にはパスしますが、完全なリトライスケジュールの後にしかパスしません。これはテストのタイムアウトを吹き飛ばすか、スイートを遅々として進ませなくします。共有のテストヘルパーにノーオペレーションのリトライを設定して、すべてのコンテナがデフォルトでそれを得るようにし、誰も覚えておく必要がないようにしましょう。

## build 内の副作用という落とし穴

リトライを盲目的に無効化するのではなく理解する価値があるのは、プロバイダーの `build` メソッドが外部から見える副作用を持つべきではないのに、実際にはしばしば持っているからです。もし `build` がアナリティクスにログを出したり、メトリクスをインクリメントしたり、スローする前にキャッシュに書き込んだりすると、リトライのたびにその副作用が繰り返されます。10 回の試行は、1 つの論理的な失敗に対して 10 個のアナリティクスイベントを意味します。リトライを低い回数に制限したり、`build` が冪等でないプロバイダーでリトライを無効化したりすることで、テレメトリを正直に保てます。これらのメソッド内で `await` の後に状態を取りに行こうとしているなら、[Flutter Riverpod 3 で非同期ギャップの後に Ref.mounted をチェックする](/ja/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)ために守るのと同じ規律が、リトライの多いプロバイダーにも当てはまります。リトライは非同期の本体全体を再度実行するからです。

もう一つの微妙な点があります。プロバイダーが無効化されてゼロから再ビルドされると、リトライ回数はリセットされます。10 回試行の予算は、アプリのセッションごとではなく、連続する失敗ストリークごとです。失敗してリトライを使い果たし、プルツーリフレッシュによって無効化され、再び失敗するプロバイダーは、新たな 10 回試行の予算を開始します。リトライが最終的に停止することに依存しているなら、無効化がそれを黙ってリセットしていないことを確認してください。

## デフォルトを選ぶ

新しい Riverpod 3.0 アプリでは、現実的なセットアップはこうです。一般的なケースのために `ProviderScope` レベルで短い制限付きリトライを保ち、リトライが役立たない個々のプロバイダーを `null` にオーバーライドする。これにより、決定論的な失敗で 13 秒のスピナーを出すことなく、ネットワーク読み取りに対する回復力が得られます。

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) {
    if (retryCount >= 2) return null; // app-wide default: 3 attempts max
    return Duration(milliseconds: 300 * (1 << retryCount));
  },
  child: const MyApp(),
)
```

Riverpod 2.x から移行してきて、機能を評価する間はどこでも古い「一度失敗したら失敗のまま」の挙動を望むなら、グローバルな `retry: (_, __) => null` が正直な出発点です。実際にどれが恩恵を受けるかがわかったら、プロバイダーごとに再びオンにしましょう。移行ノートは、[Riverpod 2.x から 3.0 へのアップグレード](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)でリトライと並んで変わった残りの部分をカバーしています。そもそも Riverpod が適切なツールなのかまだ判断中なら、[Provider vs Riverpod vs Bloc の比較](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)がこれを文脈の中に位置づけます。同じプロバイダーのローディングとエラーのレンダリング側については、[AsyncValue でローディングとエラー状態を表示する](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)方法を参照してください。

## 出典

- [Automatic retry](https://riverpod.dev/docs/concepts2/retry)：リトライコールバックのシグネチャ、デフォルト、プロバイダーごとの設定に関する Riverpod ドキュメント。
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)：リトライ機能の発表とデフォルトのバックオフ挙動。
- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration)：`ProviderContainer.test` を含む移行ガイダンス。
- [riverpod changelog](https://pub.dev/packages/riverpod/changelog)：3.x 系列のバージョン履歴。

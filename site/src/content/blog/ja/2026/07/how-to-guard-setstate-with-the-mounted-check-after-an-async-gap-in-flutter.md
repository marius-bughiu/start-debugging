---
title: "Flutter で非同期の中断後に mounted チェックで setState を守る方法"
description: "await のあと、ウィジェットはすでに破棄されている場合があり、setState を呼ぶと例外が投げられます。再開を if (!mounted) return; で守り、さらに良いのは、それを引き起こす処理自体をキャンセルすることです。Flutter 3.44 向けの完全なパターンを解説します。"
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "ja"
translationOf: "2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

ルールは一行に収まります。`State` の中では、まず `if (!mounted) return;` を確認せずに `await` のあとで `setState` を呼んではいけません。`await` は制御をイベントループに返し、非同期の処理が走っている間にユーザーは画面を閉じられ、コードが再開したときにはウィジェットがすでに破棄されている場合があります。破棄された `State` に対して `setState` を呼ぶと `setState() called after dispose()` が投げられます。`mounted` ゲッターは `State` がまだツリーにあるかどうかを教えてくれるので、これで再開を守ればクラッシュは起こりえなくなります。さらに良いのは、`setState` を呼ぶことになるタイマー・サブスクリプション・リクエストをキャンセルして、死んだウィジェット上でコールバックが一切走らないようにすることです。本ガイドは Flutter 3.44（現行の安定版、2026 年）と Dart 3.x を使用します。

`mounted` は `State<T>` 上のゲッターです。フレームワークがあなたの `State` を `BuildContext` に結びつけた瞬間から、`initState` が走る前にすでに `true` であり、`dispose` が呼ばれるまで `true` のままで、その後は永遠に `false` です。内部では要素への参照に対する null チェックにすぎません。`bool get mounted => _element != null;`。仕組みはこれだけです。あなたのウィジェットを支える要素がツリーから引き抜かれると、`_element` は null になり、`mounted` は `false` に切り替わり、その時点以降に試みるどんな `setState` もフレームワークが積極的に拒否するエラーになります。

## なぜ await こそが壊れる場所なのか

Flutter はすべてを単一の UI スレッドから動かします。イベントハンドラが同期的に走っている間は、見ているウィジェットがメソッドの途中で消えることはありません。ほかの何にも順番は回ってこないからです。`await` と書いた瞬間に、その保証は消えます。制御はイベントループに戻り、ほかのフレームがレンダリングされ、ジェスチャのコールバックが走り、ルート遷移が完了します。あなたの継続はどこか後のマイクロタスクにスケジュールされ、「await の前」と「await の後」の間に、ユーザーは戻るをタップしたかもしれず、親があなたを存在ごと再ビルドしたかもしれず、別の場所の `Navigator.pop` があなたのルートを破棄したかもしれません。

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _ProfileState extends State<Profile> {
  bool _loading = false;
  User? _user;

  Future<void> _load() async {
    setState(() => _loading = true);      // fine: still on the same frame
    final user = await api.fetchUser();    // control leaves; frames run
    setState(() {                          // may run after dispose()
      _user = user;
      _loading = false;
    });
  }
}
```

`_load` のどこも間違って見えませんし、離れない画面でテストすれば毎回動きます。ですが `fetchUser` が飛行中に画面から離れると、2 つ目の `setState` は破棄された `State` に着地します。デバッグでは `FlutterError` が返ります。`setState() called after dispose(): _ProfileState#1a2b3(lifecycle state: defunct, not mounted)`。これは [await のあとで BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) でコンテキスト側から説明したのと同じ構造的な間違いですが、ここでの犠牲者は継承ウィジェットの検索ではなく状態の変更です。

## 最小限のガード、ステップごとに

中断後に `setState` を呼ぶ `State` 内のあらゆる非同期メソッドについて、次の 3 ステップに従ってください。

1. **非同期の処理を行う。** `await` には必要なだけ時間をかけさせてください。まだ何も壊れやすいものをそれ越しに保持していません。`mounted` はキャッシュした値ではなく、生きたゲッターです。
2. **再開を守る。** `await` の直後、どの `setState` よりも前に、`if (!mounted) return;` と書きます。await の間にウィジェットがツリーを離れていたら、ここで止まり、破棄された `State` には決して触れません。
3. **ガードを通過した後だけ setState を呼ぶ。** 状態を変更してウィジェットを再ビルドするものはすべて、チェックのあと、同じ同期ティック上に置きます。そうすればガードと呼び出しの間で何かがあなたを破棄することはありません。

壊れた例に適用すると次のようになります。

```dart
// Flutter 3.44, Dart 3.x -- guarded
Future<void> _load() async {
  setState(() => _loading = true);
  final user = await api.fetchUser();   // 1. async work

  if (!mounted) return;                 // 2. guard the resume

  setState(() {                         // 3. safe: State is still mounted
    _user = user;
    _loading = false;
  });
}
```

これが一般的なケースの修正のすべてです。`mounted` は `dispose` が走った瞬間に `false` になるので、ガードは例外を投げていたであろうまさにそのときに `setState` をスキップします。ガードは await のあとに `mounted` を新鮮に読むことに注意してください。await の *前* に置いたチェックは何も教えてくれません。気にすべき中断は await そのものだからです。

## なぜ mounted のチェックは天井ではなく床なのか

Flutter フレームワークはこの点について `setState` のエラー文自体ではっきりしています。推奨される修正は `mounted` をチェックすることだけではなく、そもそも `setState` を呼ぶことになる処理をキャンセルすることです。理由はこうです。`mounted` ガードは例外を防ぎますが、非同期の処理はそれでも最後まで走り、あとで捨てる結果を生み出すために CPU・ネットワーク・バッテリーを消費しました。`Timer` が 10 分前にユーザーが離れた画面上で毎秒発火するなら、各ティックを `mounted` で守ってもクラッシュは止まりますが、タイマーは永遠に走り続けます。

ですから `if (!mounted) return;` を最後の防衛線として扱い、ソースがキャンセル可能なところでは `dispose` でソースをキャンセルすることを本当の修正としてください。

```dart
// Flutter 3.44, Dart 3.x -- cancel the source, then guard as backup
class _ClockState extends State<Clock> {
  Timer? _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;             // backstop
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();                   // the real fix: stop the source
    super.dispose();
  }
}
```

`dispose` の `cancel()` があれば、コールバックはウィジェットが離れた瞬間に発火をやめるので、`mounted` ガードはほとんど作動しません。それでもガードを残すのはコストゼロで、`dispose` が走るときにティックがすでにキューに入っている狭い競合をカバーします。これは [メモリリークを避けるためにコントローラーを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) ときに適用するのと同じ規律です。あなたのウィジェットにコールバックし得るものの、そのライフサイクルを自分のものにするのです。

## Stream のサブスクリプションは典型的な違反者

`onData` が `setState` を呼ぶ `StreamSubscription` は、キャンセルしない限り、ウィジェットが消えたあともイベントを配信し続けます。サブスクリプションを保持し、`dispose` でキャンセルしてください。

```dart
// Flutter 3.44, Dart 3.x
class _FeedState extends State<Feed> {
  StreamSubscription<Item>? _sub;
  final _items = <Item>[];

  @override
  void initState() {
    super.initState();
    _sub = repository.itemStream.listen((item) {
      if (!mounted) return;
      setState(() => _items.add(item));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
```

ここで `cancel()` を忘れるのは、本番のログで `setState() called after dispose()` を見る最も一般的な原因のひとつです。ストリームがウィジェットより長生きし、破棄後に届く各イベントは `mounted` ガードが静かに吸収しているクラッシュです。サブスクリプションをキャンセルすれば、イベントはソースで止まります。開くすべてのリスナーを `dispose` でキャンセルすることは、[リークを防ぐコントローラーの破棄](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) と同じくらい自動的にする価値があります。

## State の mounted と BuildContext の mounted

`mounted` ゲッターは 2 つあり、正しいほうを選ぶことが重要です。`State.mounted` は本ガイド全体が扱うもので、あなたの状態クラスに存在し、あなたが所有するウィジェットのライフサイクルを追い、`setState` の前にチェックするものです。Flutter の最初期のバージョンから存在します。

`BuildContext.mounted` は Flutter 3.7 で、`State` ではなくコンテキストしか持たないコード、すなわちヘルパー関数・`StatelessWidget` のコールバック・拡張メソッド向けに登場しました。「この要素はまだツリーにあるか」という同じ問いに答えますが、スコープに `State` がないときに手を伸ばします。

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass, before setState:
if (!mounted) return;          // State.mounted

// In a helper that only has a BuildContext:
if (!context.mounted) return;  // BuildContext.mounted
```

`State` の中では、`context.mounted` より `mounted` を優先してください。ふつうは一致しますが、`State.mounted` はあなたがまさに `setState` を呼ぼうとしている当のオブジェクトのライフサイクルを読みます。それこそが無効になり得るものです。`context.mounted` は、状態の変更ではなく `Navigator` や `ScaffoldMessenger` の検索がペイロードである、[await のあとで BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) で扱う状況のために取っておいてください。

## 複数の await は複数のガードを意味する

各中断点がウィンドウを再び開きます。メソッドが 2 回 await を行い、それぞれのあとで `setState` を呼ぶなら、最初だけでなく各 await のあとにガードが必要です。

```dart
// Flutter 3.44, Dart 3.x
Future<void> _submit() async {
  setState(() => _status = 'validating');
  final valid = await validate(form);
  if (!mounted) return;                 // guard after await #1

  setState(() => _status = valid ? 'saving' : 'invalid');
  if (!valid) return;

  await repository.save(form);
  if (!mounted) return;                 // guard after await #2

  setState(() => _status = 'done');
}
```

ガードはそれに先行する await だけをカバーします。既存のガードと `setState` の間に新しい `await` を追加すると、静かに中断を再び開いたことになります。メソッドがこうしたガードを 2 つより多く生やすときは、ふつう非同期の処理が命令的な `setState` 呼び出しの山ではなく、コントローラー・`AsyncNotifier`・あるいはウィジェットが宣言的にレンダリングするストリームに属するというサインです。それを [AsyncValue によるローディングとエラーの状態](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) としてモデル化すると、ライフサイクルの管理をフレームワークに引き渡し、ほとんどの手動ガードを完全に取り除けます。

## リンターはこれを捕まえません

ここでツールが何をして何をしないかについては、はっきりさせておく価値があります。`flutter_lints` の `use_build_context_synchronously` リンターは、ガードなしで非同期の中断後に使われた `BuildContext` を指摘します。await のあとの裸の `setState` は指摘 **しません**。`setState` はコンテキストを取らず、リンターはそれを探していないからです。本記事の最初の例にある無防備な `setState` に下線を引く解析ルールは存在しません。これにより、この習慣は完全にあなたが守るものになります。コンパイラは黙り、アナライザーは黙り、唯一のシグナルは、ユーザーが間違ったタイミングで画面から離れたあとのログのクラッシュです。

実際的な帰結として、赤い波線に頼ってこれらを見つけることはできません。`await` を行い、かつ `setState` を呼ぶ `State` メソッドをすべて監査し、`super.dispose()` をすでに扱っているのと同じように、ガードを反射にしてください。

## 落とし穴とそっくりさん

**これは build 中の setState とは別のクラッシュです。** クラッシュ `setState() called after dispose()` とクラッシュ `setState() or markNeedsBuild() called during build` は、文面は似ていても無関係です。dispose のほうは `setState` を遅すぎるタイミング、ウィジェットが消えたあとで呼ぶことについてで、build のほうは早すぎるタイミング、build パスの中で同期的に呼ぶことについてです。修正は異なり、[build 中に呼ばれる setState のガード](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) が 2 つ目をカバーします。スタックトレースが "during build" と言っているなら、`mounted` チェックはあなたの修正ではありません。

**リリースビルドでもやはりクラッシュします、ただし遅れて。** エラー `setState() called after dispose()` はデバッグ限定のアサーションではなく、実際に投げられる `FlutterError` なので、破棄されたコンテキストの検索とは違ってリリースにも現れます。ですが非同期のコールバックから発火するため、スタックトレースはしばしばあなたの `_load` メソッドから遠いフレームワークのコードを指し、誤って帰属させやすくなります。ナビゲーションのあとにだけ、`Future.then` やストリームハンドラの中から現れるクラッシュは、ほぼ常に無防備な await 後の `setState` です。

**`FutureBuilder` と `StreamBuilder` はガードを回避します。** 非同期の処理を手で `setState` を呼ぶ代わりに `FutureBuilder` や `StreamBuilder` に渡せば、ビルダーがウィジェットのライフサイクルを代わりに追い、死んだ `State` に対して決して `setState` を呼びません。[手動の setState より FutureBuilder や StreamBuilder](/ja/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) に手を伸ばすと、非同期のフローをビルダーを中心に再構成する代償と引き換えに、この種のクラッシュをまるごと 1 カテゴリ取り除けます。

**Riverpod での相当物。** `State` ではなく `WidgetRef` や notifier の `Ref` を保持している場合、対応するクラッシュは破棄された `State` のエラーではなく破棄された ref のエラーで、ガードは `mounted` ではなく `ref.mounted` です。根本原因は同じ、修正の形も同じで、[Riverpod 3.0 で非同期の中断後に Ref.mounted を確認する](/ja/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) で扱っています。

## クラッシュを引退させる習慣

`State` は、同期的な実行の始まりから次の `await` までの間だけ有効だと読んでください。再開したら、`setState` を呼ぶ前に `mounted` をチェックします。そして `setState` を引き起こすものがタイマー・サブスクリプション・あるいは長寿命のソースであるところでは、`dispose` でそれをキャンセルし、すでに消えたウィジェット上でコールバックが決して発火しないようにします。それを機械的に行えば、`setState() called after dispose()` はログに現れなくなります。クラッシュと、その裏にある無駄な処理の両方を取り除いたからです。

## 出典

- [State.mounted プロパティ](https://api.flutter.dev/flutter/widgets/State/mounted.html)、Flutter API ドキュメント。`State` のライフサイクル全体で `mounted` がいつ true でいつ false かについて。
- [State.setState メソッド](https://api.flutter.dev/flutter/widgets/State/setState.html)、Flutter API ドキュメント。`setState() called after dispose()` エラーを詳述し、単に `mounted` をチェックするよりソースをキャンセルすることを推奨しています。
- [State.dispose メソッド](https://api.flutter.dev/flutter/widgets/State/dispose.html)、Flutter API ドキュメント。ウィジェットがツリーを離れるときにタイマーとサブスクリプションを解放することについて。
- [use_build_context_synchronously リンタールール](https://dart.dev/tools/linter-rules/use_build_context_synchronously)、Dart リンタールール。アナライザーが何を指摘し何を指摘しないかについて。

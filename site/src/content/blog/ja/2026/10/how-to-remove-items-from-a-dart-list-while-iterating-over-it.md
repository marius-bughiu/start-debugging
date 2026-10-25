---
title: "Dart の List を反復処理しながら ConcurrentModificationError を出さずに要素を削除する方法"
description: "for-in ループや forEach の中で remove を呼ぶと ConcurrentModificationError がスローされます。その場でフィルタリングするなら removeWhere、新しいリストを作るなら where か collection-for、インデックスで回すなら逆順のループを使います。Dart 3.13.7 で検証し、ループ内の removeAt が遅い理由をベンチマークで示します。"
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "collections"
  - "errors"
lang: "ja"
translationOf: "2026/10/how-to-remove-items-from-a-dart-list-while-iterating-over-it"
translatedBy: "claude"
translationDate: 2026-10-25
---

**短い答え:** `for (final x in list)` ループや `list.forEach` が `List` を走査している間に、その `List` に対して `remove`、`removeAt`、`add` を呼ぶことはできません。イテレーターは毎ステップでリストの長さを確認し、長さが変わった瞬間に `ConcurrentModificationError` をスローするからです。その場でフィルタリングしたいならループを `list.removeWhere((x) => condition)` に置き換え、イミュータブルな更新が必要なら `list.where((x) => !condition).toList()` (または collection-for) で新しいリストを作ります。どうしてもインデックスのループが必要なら、`list.length - 1` から `0` に向かって逆順に回します。以下の内容はすべて Dart 3.13.7 (Flutter 3.47.8 に同梱されている SDK) で、VM、AOT、JavaScript へのコンパイルのそれぞれで実行しています。

## エラーの実例

ほとんどの人が最初に書くのはこのコードです:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3];
  for (final n in numbers) {
    if (n == 1) numbers.remove(n);
  }
}
```

そして VM は次のように出力します:

```
Unhandled exception:
Concurrent modification during iteration: Instance(length:2) of '_GrowableList'.
#0      ListIterator.moveNext (dart:_internal/iterable.dart:366:7)
#1      main (file:///.../main.dart:4:19)
```

メッセージの `length:2` は変更 *後* のリストの長さで、`_GrowableList` は通常の `[]` リテラルに対する VM の実装クラスです。Web では同じコードが `Concurrent modification during iteration: Instance of 'JSArray<int>'.` で失敗するので、バグ報告が Flutter web のビルドから来た場合はログで `_GrowableList` を検索しても見つかりません。Map と Set にはそれぞれ `_Map len:2.` と `_Set len:2.` という独自のバリエーションがありますが、根本原因は同じです。

## イテレーターが単に読み飛ばさずにエラーをスローする理由

`List` に対する `for-in` ループは、`list.iterator` を取得して `moveNext()` が `false` を返すまで呼び出すための糖衣構文です。Dart がリストに使うイテレーター、つまり `dart:_internal` の `ListIterator` は、生成時にリストの長さを記録し、`moveNext()` のたびにそれを比較します:

```dart
// dart:_internal, sdk/lib/internal/iterable.dart (Dart 3.13.7)
bool moveNext() {
  int length = _iterable.length;
  if (_length != length) {
    throw ConcurrentModificationError(_iterable);
  }
  if (_index >= length) {
    _current = null;
    return false;
  }
  _current = _iterable.elementAt(_index);
  _index++;
  return true;
}
```

`List.forEach` も各コールバックの後に同じチェックを行い、`removeWhere` は自分自身のループの中でチェックします。エラーがスローされるのはリストを変更した行ではなく *次の* ステップです。スタックトレースが `remove` ではなく `moveNext` を指しているのはこのためです。

[`Iterable` のドキュメント](https://api.dart.dev/dart-core/Iterable-class.html) は契約をはっきり書いています。反復処理中にコレクションを変更することは基本的に許されず、その破綻は通常、次に Iterator.moveNext が呼ばれたときに ConcurrentModificationError をスローすることで通知されます。このチェックがあるのは、代わりの挙動のほうが悪いからです。要素 `i` を削除するとそれ以降の要素がすべて 1 つ左にずれるので、インデックスベースのイテレーターは位置 `i` に滑り込んできた要素を黙って読み飛ばしてしまいます。Dart ははっきり失敗するほうを選んでいます。

「次の `moveNext()`」には、多くの人が驚く 2 つの帰結があります:

- **最後の要素を削除してもエラーになります。** `[1, 2, 3, 4]` から最後の反復で `4` を削除するなら、もう訪れる要素がないので安全だと思うかもしれません。そうではありません。ループは終了を確認するためにもう一度 `moveNext()` を呼び、長さが変わったことに気づいてエラーをスローします。
- **追加してもエラーになります。** ループ内の `numbers.add(x)` は `remove` と同じように長さを変えます。Dart には Java のような `Iterator.remove()` がないので、イテレーター経由で「安全に」変更する方法は存在しません。

## 適切な修正の選び方

私が使っている判断の順番は次のとおりです。それぞれの選択肢は後で詳しく説明します。

1. 既存のリストからその場で要素を取り除きたいなら、`removeWhere` (逆の条件なら `retainWhere`) を呼びます。
2. リストがイミュータブルな状態の一部 (Riverpod、Bloc、`ValueNotifier`、ウィジェットに渡す `final` フィールド) なら、`where(...).toList()` か collection-for で新しいリストを作って代入します。
3. 削除の判断がインデックスや隣の要素に依存するなら、インデックスを逆順に回して `removeAt` を使います。
4. ループ本体で多くの処理を行い、その一部だけが要素を削除するなら、コピー (`for (final x in list.toList())`) を走査して元のリストから削除します。

## 修正 1: その場でフィルタリングする `removeWhere`

これが定番の答えで、デフォルトの選択肢にすべきものです:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 2, 3];
  numbers.removeWhere((n) => n == 2);
  print(numbers); // [1, 3]

  final tasks = <({String title, bool done})>[
    (title: 'write post', done: true),
    (title: 'review PR', done: false),
  ];
  tasks.retainWhere((t) => !t.done);
  print(tasks); // [(done: false, title: review PR)]
}
```

`removeWhere` は 1 回の走査で済みます。共通の `ListBase` 実装では、リストを 1 回走査して残す要素を集め、1 回の `setRange` で書き戻してから長さを切り詰めます。引数と等しい最初の要素だけを削除する `remove` と違い、条件に一致するすべての要素を削除します。しかも、後述のベンチマークのとおり圧倒的に高速です。

Map と Set にも同じメソッドがあります。`map.removeWhere((key, value) => value == 2)` と `set.removeWhere((x) => x.isEven)` が、このエラーの `_Map` 版と `_Set` 版に対する修正です。

述語の中でも守るべきルールが 1 つあります。`test` の中からリストを変更しないことです。`numbers.add(...)` を呼ぶ述語は、`for-in` ループと同じ理由で `removeWhere` の内部から `ConcurrentModificationError` をスローします。

## 修正 2: 変更せずに新しいリストを作る

他のコードが参照を持っている状態にリストが属しているなら、その場で変更すること自体が本当のバグで、`ConcurrentModificationError` はたまたま表に出た症状にすぎません。新しいリストを作ります:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3, 4];

  final odds = numbers.where((n) => n.isOdd).toList();
  final alsoOdds = [for (final n in numbers) if (n.isOdd) n];

  print(odds);     // [1, 3]
  print(alsoOdds); // [1, 3]
  print(numbers);  // [1, 2, 3, 4], untouched
}
```

Flutter では、再ビルドを引き起こすものすべてにこの形を使います:

```dart
// Flutter 3.47.8, Dart 3.13.7, flutter_riverpod 3.x
class TodoList extends Notifier<List<Todo>> {
  @override
  List<Todo> build() => const [];

  void clearCompleted() {
    state = [for (final t in state) if (!t.done) t];
  }
}
```

Riverpod、Bloc、`ValueNotifier` は、新しい値が代入され、それが古い値と異なる場合にだけリスナーに通知します。`state.removeWhere(...)` は何も代入せずに同じリストのインスタンスを変更するので、何も再ビルドされません。さらに `state` が `const []` や `List.unmodifiable` で作られていた場合は、代わりに `UnsupportedError: Cannot remove from an unmodifiable list` がスローされます。`setState` を使うウィジェットをこのモデルに移行するなら、[setState から Riverpod の Notifier への移行](/ja/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/) で残りの手順を説明しています。

遅延評価には注意してください。`where` は消費するたびに元のリストから読み出す遅延 `Iterable` を返すので、次のコードもエラーになります:

```dart
// Dart 3.13.7: throws ConcurrentModificationError
for (final n in numbers.where((n) => n.isEven)) {
  numbers.remove(n);
}
```

結果を実体化し、元のリストとのつながりを断ち切るのは `.toList()` です。

## 修正 3: インデックスを逆順に回す

判断が位置に依存することもあります。「直前の要素と等しければ削除する」や「最初のエラー以降のエントリーをすべて削除する」といったケースです。逆順に回す限り、ここではインデックスのループで問題ありません:

```dart
// Dart 3.13.7
void main() {
  final values = [1, 2, 2, 3, 3, 3, 4];

  // Remove consecutive duplicates.
  for (var i = values.length - 1; i > 0; i--) {
    if (values[i] == values[i - 1]) values.removeAt(i);
  }
  print(values); // [1, 2, 3, 4]
}
```

インデックスのループはイテレーターに触れないので、`ConcurrentModificationError` をスローすることはありません。ただし、だからといって順方向のループが正しくなるわけではありません:

```dart
// Dart 3.13.7: no exception, wrong answer for adjacent matches
final numbers = [1, 2, 2, 3];
for (var i = 0; i < numbers.length; i++) {
  if (numbers[i] == 2) numbers.removeAt(i);
}
print(numbers); // [1, 2, 3]  (one 2 survived)
```

`removeAt(1)` が実行されると 2 つ目の `2` がインデックス 1 に滑り込み、その後 `i++` がそれを飛ばしてしまいます。逆順に回せば、インデックス `i` の削除でずれるのはすでに訪れた要素だけなので、この問題は起きません。どうしても順方向のループにしたいなら、削除しなかったときだけ `i` を進めますが、逆順のループのほうが間違えにくいです。

## 修正 4: コピーを走査する

ループ本体が実際の処理 (ログ出力、コールバックの呼び出し、他のデータ構造の更新) を行い、削除が一部の反復の副作用にすぎない場合は、スナップショットを走査するとコードが読みやすく保てます:

```dart
// Dart 3.13.7
void main() {
  final pending = [1, 2, 2, 3];
  for (final job in pending.toList()) {
    final ok = job != 2; // pretend this ran the job
    if (ok) pending.remove(job);
  }
  print(pending); // [2, 2]
}
```

`toList()` のコストは 1 回のアロケーションと参照のコピーで、UI 規模のリストなら無視できます。`remove(job)` は `job` と等しい *最初の* 要素を削除する点に注意してください。一意なオブジェクトなら問題ありませんが、重複する値では意外な結果になります。`Map` の場合は `for (final key in map.keys.toList())` が同等の書き方です。

## ループ内の `removeAt` が遅い理由

`removeAt(i)` は毎回 `i` 以降のすべての要素を 1 つ左にずらすので、長さ `n` のリストから `k` 個の要素を削除すると、おおよそ `O(n * k)` 回の要素移動が発生します。`removeWhere` と `where(...).toList()` は 1 回の `O(n)` の走査です。200,000 要素の `List<int>` から偶数 100,000 個を削除する処理で 3 つを計測しました。Apple Silicon の Mac で `dart compile exe` を使ってコンパイルしています:

```dart
// Dart 3.13.7, dart compile exe, macOS arm64
void main() {
  const n = 200000;
  var a = List<int>.generate(n, (i) => i);
  var sw = Stopwatch()..start();
  for (var i = a.length - 1; i >= 0; i--) {
    if (a[i].isEven) a.removeAt(i);
  }
  print('removeAt backwards: ${sw.elapsedMilliseconds} ms');

  var b = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  b.removeWhere((x) => x.isEven);
  print('removeWhere: ${sw.elapsedMicroseconds} us');

  var c = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  final d = c.where((x) => x.isOdd).toList();
  print('where.toList: ${sw.elapsedMicroseconds} us (${d.length})');
}
```

| 方法 | 時間 (3 回の実行の中央値) |
| --- | --- |
| 逆順の `removeAt` ループ | ~3,720 ms |
| `removeWhere` | ~1.0 ms |
| `where(...).toList()` | ~1.45 ms |

3 桁半の差です。20 件の ToDo リストならどれでも関係ないので、最も読みやすいものを選んでください。データを処理するもの (パースした CSV の行、ログのエントリー、キャッシュの掃除) では `removeWhere` を使い、インデックスのループは本当に位置が必要なロジックのためにとっておきます。非常に大きなリストを UI スレッドの外で処理する必要があるなら、[Dart の isolate で処理を実行する](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) ことでフレームはなめらかに保てますが、`O(n^2)` のループが直るわけではありません。

## 削除した要素も必要な場合

`removeWhere` の戻り値は `void` なので、何が削除されたかはわかりません。つい書きたくなる修正は述語を 2 回呼びます:

```dart
final removed = items.where(isExpired).toList();
items.removeWhere(isExpired);
```

これが正しいのは `isExpired` が決定的な場合だけです。`DateTime.now()` を読んでいると、2 回の呼び出しの間に要素が期限切れになり、`removed` に現れないまま消えることがあります。代わりに 1 回の走査で分割します:

```dart
// Dart 3.13.7
extension RemoveAndCollect<E> on List<E> {
  List<E> removeWhereAndCollect(bool Function(E element) test) {
    final removed = <E>[];
    final kept = <E>[];
    for (final e in this) {
      (test(e) ? removed : kept).add(e);
    }
    if (removed.isNotEmpty) {
      setRange(0, kept.length, kept);
      length = kept.length;
    }
    return removed;
  }
}

void main() {
  final items = [1, 2, 3, 4, 5];
  final evens = items.removeWhereAndCollect((x) => x.isEven);
  print(items); // [1, 3, 5]
  print(evens); // [2, 4]
}
```

ここでの `for-in` は、ループが終わるまで `this` を変更するものがないので安全です。

## エラーを隠したり変えたりする落とし穴

**同じ反復の中で削除してから追加すると、ループが黙って壊れます。** イテレーターは長さしか比較しません。ある反復で要素を 1 つ削除して別の要素を 1 つ追加すると、長さは変わらず、何もスローされません:

```dart
// Dart 3.13.7: no exception, element 3 is never visited
final l = [1, 2, 3, 4];
for (final x in l) {
  print('visit $x'); // visit 1, visit 2, visit 4, visit 20
  if (x == 2) {
    l.remove(x);
    l.add(20);
  }
}
```

`3` はすでに訪れた位置に滑り込み、読み飛ばされました。`ConcurrentModificationError` が出ないことは、コードが正しい証明にはなりません。`l[i] = newValue` のように要素をその場で置き換えるのは本当に問題ありません。長さも変わらず、何もずれないからです。

**ループ内の `await` は他のコードが割り込む隙を作ります。** Flutter アプリで断続的なクラッシュとして現れるのはこのパターンです:

```dart
// Dart 3.13.7
import 'dart:async';

Future<void> main() async {
  final items = [1, 2, 3];
  Timer(const Duration(milliseconds: 5), () => items.removeAt(0));

  for (final x in items) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    print('processed $x');
  }
  // processed 1, then ConcurrentModificationError
}
```

ループ本体の中では何も `items` に触れていません。触れているのは、`await` の間に実行されるタイマー、stream のリスナー、ボタンのタップハンドラーです。修正は修正 4 と同じで、`items.toList()` を走査するか、共有リストをイミュータブルにして置き換えます。非同期ループが `State` の中にあるなら、まさにこの隙間で [setState を呼ぶ前の mounted チェック](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) も必要になります。また、ループ内で `await` していない呼び出しは、[`unawaited_futures` と `discarded_futures` の lint](/ja/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) が検出するためにあるものです。

**Map は値の更新は許容しますが、キーの変更は許容しません。** `for (final k in map.keys) map[k] = 0;` は、既存のキーの更新では Map の構造が変わらないので問題ありません。`map.remove(k)` や新しいキーの追加はエラーになります。存在しないキーの削除は何もせず、エラーもスローしません。

**自分自身への `addAll` は即座にエラーになります。** VM の growable なリストに対する `list.addAll(list)` は、ループがどこにもなくても `ConcurrentModificationError` をスローします。`list.addAll(list.toList())` か `[...list, ...list]` を使ってください。

**固定長リストと変更不可能なリストは、このエラーではなく `UnsupportedError` をスローします。** `List.filled(3, 0).removeWhere(...)` は `Unsupported operation: Cannot remove from a fixed-length list` を、`const` リストや `List.unmodifiable` は `Cannot remove from an unmodifiable list` をスローします。[`removeWhere` のドキュメント](https://api.dart.dev/dart-core/List/removeWhere.html) にも、リストは growable でなければならないと明記されています。こうしたケースには修正 2 を使います。

**`ListView` の元になっているリストから削除するときは key が必要です。** `setState(() => _items.removeWhere(...))` の後、key を与えていない限り Flutter は古い子と新しい子を位置で対応付けるので、要素ごとの状態 (チェックボックス、テキストフィールド、アニメーション) が別の行に移ってしまうことがあります。[Flutter の key についての記事](/ja/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/) で `ValueKey(item.id)` による修正を解説しています。

### 次に読む

- [Flutter で非同期の隙間の後に mounted チェックで setState を守る方法](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Flutter の Key とは何か、省略するとどんなバグが起きるのか](/ja/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [setState を使う StatefulWidget を Riverpod の Notifier に移行する](/ja/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Dart の unawaited_futures と discarded_futures の lint の違い](/ja/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)

### 参考資料

- [`Iterable` クラスのドキュメント](https://api.dart.dev/dart-core/Iterable-class.html)、反復処理中のコレクション変更に関するセクション
- [`ConcurrentModificationError` クラス](https://api.dart.dev/dart-core/ConcurrentModificationError-class.html)
- [`List.removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) と [`List.retainWhere`](https://api.dart.dev/dart-core/List/retainWhere.html)
- Dart SDK のソースコード: [`sdk/lib/internal/iterable.dart` の `ListIterator.moveNext`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/internal/iterable.dart) と [`sdk/lib/collection/list.dart` の `ListBase._filter`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/collection/list.dart)

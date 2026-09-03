---
title: "Flutter の Web アプリを dart:html から package:web と dart:js_interop へ移行する"
description: "非推奨になった dart:html、dart:js_util、package:js から package:web 1.1.1 と dart:js_interop へ移行する手順です。問題のある import を dart2wasm コンパイラーで洗い出す方法、dart fix がリネームするものとしないもの、JSImmutableListWrapper と innerHTML の落とし穴、そして flutter build web --wasm による検証までを扱います。"
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "flutter-web"
  - "interop"
  - "webassembly"
lang: "ja"
translationOf: "2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web"
translatedBy: "claude"
translationDate: 2026-09-03
---

`dart:html` の呼び出しが数箇所しかない単一アプリの Flutter Web コードなら、移行は半日で終わります。`dart:html` が共有パッケージやモック、あるいは自分で保守しているプラグインまで染み出しているコードベースでは 1 週間かかり、その大半を占めるのは自分のコードではありません。いまだに古いライブラリを import している推移的な依存関係です。これはもう任意の作業ではありません。`dart:html`、`dart:js`、`dart:js_util`、`package:js` は Dart 3.7 (2025 年 2 月) で非推奨になり、いずれも `dart2wasm` ではコンパイルできません。置き換え先である [`package:web`](https://pub.dev/packages/web) 1.1.1 と `dart:js_interop` の組み合わせは 2024 年 7 月から安定版です。本記事が対象とするのは現在の stable チャンネル、Dart 3.13.2 を含む Flutter 3.47.2 (2026-08-27 リリース) と、Dart `^3.4.0` を要求する `package:web` 1.1.1 です。以下のコンパイラー出力はすべて、stable のツールチェーン Flutter 3.44.8 / Dart 3.12.2 と同じ `package:web` 1.1.1 で実際に実行して取得したものです。

## これ以上先延ばしにできない理由

- **WebAssembly がこれに依存しています。** `dart2wasm` は推移的に `dart:html` に到達するプログラムのコンパイルを拒否します。[`flutter build web --wasm` で Flutter の Web アプリをビルドする](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/)で説明した利点が欲しいなら、この移行は最適化ではなく参加費です。
- **非推奨はすでに効いています。** `dart analyze` は import 行そのものに `deprecated_member_use` を報告するので、`--fatal-infos` を付けた CI ジョブはすでに失敗しているか、設定変更ひとつで失敗する状態です。
- **`package:web` は SDK とは別にバージョン管理されます。** ブラウザー API の追加は SDK のリリースを待たずにパッケージのバージョンとして届きますし、`package:web` は Web IDL から直接生成されるため、2013 年頃の Dart のスタイルガイドではなく MDN と名前が一致します。
- **パッケージを公開しているなら、移行するまで利用者は Wasm にコンパイルできません。** リーフパッケージの `dart:html` import がひとつあるだけで、その下流の依存グラフ全体がブロックされます。

## 壊れるもの

| 領域 | 変更 | 深刻度 |
| ---- | ---- | ------ |
| 型名 | Dart 風の名前が IDL の名前に戻ります。`HtmlElement` は `HTMLElement` に、`InputElement` は `HTMLInputElement` に、`AnchorElement` は `HTMLAnchorElement` になります | 高いが、ほぼ自動化可能 |
| コレクション | `querySelectorAll` と `children` は `List` を実装しない `NodeList` / `HTMLCollection` を返します | 高 |
| 型チェック | `package:web` の型はすべて `JSObject` に消去されるため、ブラウザーの型に対する `is` と `as` は機能しません | 高 |
| モック | extension type には仮想ディスパッチがないため、`dart:html` のクラスを `implements` するモックでは `package:web` の型を実装できません | 高 |
| 型シグネチャ | `innerHTML` は `JSAny` で、イベントリスナーは `JSFunction` を受け取るため、呼び出し側に `.toJS` が必要です | 中 |
| ゾーン | コールバックが現在のゾーンに自動でバインドされなくなります | 中 |
| 条件付き import | `dart.library.html` を `dart.library.js_interop` に変更する必要があります | 中 |
| プラットフォームビュー | ビューのファクトリーは `package:web` の要素を返し、`dart:ui_web` 経由で登録する必要があります | 中 |
| `dart:js_util` | `getProperty` / `setProperty` / `callMethod` は `JSAny` のキーとともに `dart:js_interop_unsafe` へ移動します | 低、機械的 |

## 事前チェックリスト

- stable チャンネルの Flutter 3.47.2 以降。Flutter 3.22 (Dart 3.4) 以降であれば動作しますが、以下で説明するアナライザーの修正は新しい SDK のほうが優れています。
- `flutter pub add web`。`web: ^1.1.1` に解決されます。
- Wasm ビルドをまだ配信していなくても `flutter build web --wasm` を実行する CI ジョブ。依存関係に潜む古い import を確実に検出できる唯一の手段です。
- `main` への細かいコミットの連続ではなく、専用のブランチ。リネームのパスは一度に多数のファイルへ触れるため、小分けにするとレビューが苦しくなります。
- 依存しているパッケージのうち、最終公開が 2024 年半ばより前のものの一覧。それがブロッカーになりやすい候補です。

## 移行手順

1. **問題のある import は grep ではなくコンパイラーで洗い出します。** `grep -r "dart:html" lib/` は自分のコードは見つけますが、実際にブロックしている 3 階層下の依存関係を見逃します。`dart2wasm` は代わりに import の連鎖を丸ごと出力します。`flutter build web --wasm` を実行して最初のエラーを読んでください。

   ```text
   Target dart2wasm failed: ProcessException: Process exited abnormally with exit code 254:
   lib/legacy_bit.dart:1:8: Error: Dart library 'dart:html' is not available on this platform.
   import 'dart:html' as html;
          ^
   Context: The unavailable library 'dart:html' is imported through these packages:

       main.dart => package:fweb => dart:html

   Detailed import paths for (some of) the these imports:

       main.dart => package:fweb/main.dart => package:fweb/legacy_bit.dart => dart:html
   ```

   有用なのは "Detailed import paths" のブロックです。連鎖が自分の `lib/` ではなく pub のパッケージで終わっている場合、アプリを移行する前に更新・フォーク・置き換えのいずれかが必要な依存関係を見つけたということです。

   検証: コンパイラーが出力したすべてのパスを書き出し、「自分のコード」「自分のパッケージ」「サードパーティー」のいずれかに分類してあること。「たぶん大丈夫」で残しているものがないこと。

2. **import を差し替えて依存関係を追加します。** ファイルごとに `import 'dart:html' as html;` を `import 'package:web/web.dart' as web;` にします。プレフィックスは残してください。プレフィックスなしで `package:web` を import すると数百のトップレベル名がスコープに入り、Flutter 自身の `Element`、`Image`、`Text` と衝突します。

   ```console
   flutter pub add web
   ```

   検証: `flutter pub deps | grep web` が `web 1.1.1` を表示し、そのファイルのエラーが "deprecated" から未定義名の一覧に変わること。未定義名は前進です。リネーム作業が可視化された状態にすぎません。

3. **型のリネームは `dart fix` に任せ、残りを手で仕上げます。** `package:web` は 141 個のリネーム変換を含む `lib/fix_data.yaml` を同梱しているので、新しい import さえ入っていればアナライザーが古い型名の大半を書き換えられます。

   ```console
   dart fix --dry-run
   dart fix --apply
   ```

   `InputElement`、`HtmlElement`、`CheckboxInputElement` を含むファイルでは、`dart fix --apply` は前の 2 つを書き換え、3 つ目には手を付けません。

   ```dart
   // After dart fix --apply, package:web 1.1.1
   final HTMLInputElement input = HTMLInputElement();
   final HTMLElement box = document.querySelector('#box') as HTMLElement;
   final CheckboxInputElement cb = CheckboxInputElement(); // still undefined
   ```

   `CheckboxInputElement` はリネームではなく、IDL に対応物のない `dart:html` の便宜的な型です。手作業での書き方は `HTMLInputElement()..type = 'checkbox'` です。変換が用意されていない名前に出会ったら、古い `dart:html` クラスの `@Native` アノテーションを調べてください。その値が `package:web` での名前です。

   検証: 移行したファイルについて `dart analyze` が `undefined_class` と `undefined_function` の診断をひとつも報告しないこと。

4. **`dart:js_util` と `package:js` を `dart:js_interop` に置き換えます。** 古い動的アクセサーは `dart:js_interop_unsafe` へ移り、キーは `String` ではなく `JSAny` を取ります。宣言的な interop は `@JS()` クラスから `JSObject` 上の extension type へ移行します。変更前:

   ```dart
   // dart:html + dart:js_util, Dart 3.12.2
   import 'dart:convert';
   import 'dart:html';
   import 'dart:js_util' as js_util;

   void downloadCsv(String csv) {
     final blob = Blob([csv], 'text/csv');
     final url = Url.createObjectUrlFromBlob(blob);
     AnchorElement(href: url)
       ..download = 'report.csv'
       ..click();
     Url.revokeObjectUrl(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final text = await HttpRequest.getString(path);
     return jsonDecode(text) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = js_util.getProperty(window, 'myLegacyGlobal');
     if (maybe != null) {
       js_util.callMethod(maybe, 'init', ['flutter']);
     }
   }
   ```

   変更後:

   ```dart
   // package:web 1.1.1 + dart:js_interop, Dart 3.12.2
   import 'dart:convert';
   import 'dart:js_interop';
   import 'dart:js_interop_unsafe';
   import 'package:web/web.dart';

   void downloadCsv(String csv) {
     final blob = Blob([csv.toJS].toJS, BlobPropertyBag(type: 'text/csv'));
     final url = URL.createObjectURL(blob);
     final anchor = document.createElement('a') as HTMLAnchorElement
       ..href = url
       ..download = 'report.csv';
     anchor.click();
     URL.revokeObjectURL(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final response = await window.fetch(path.toJS).toDart;
     final text = await response.text().toDart;
     return jsonDecode(text.toDart) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = globalContext.getProperty<JSObject?>('myLegacyGlobal'.toJS);
     if (maybe != null) {
       maybe.callMethod<JSAny?>('init'.toJS, 'flutter'.toJS);
     }
   }
   ```

   身体で覚えるべきパターンは 3 つです。`allowInterop(fn)` は `fn.toJS` になり、`js_util.promiseToFuture(p)` は `p.toDart` になり、`.toDart` で待ち受けた `JSPromise<T>` は `Future<T>` を返します。`HttpRequest` に使う価値のある直接の置き換えはありません。答えは `window.fetch` か `package:http` です。

   検証: `dart analyze` がクリーンで、リポジトリ内のどのファイルも `dart:js`、`dart:js_util`、`package:js` を import していないこと。

5. **プラットフォームビューのファクトリーを `dart:ui_web` に移します。** HTML ビューを登録するコードは、これからは `package:web` の要素を返す必要があります。レジストリは `dart:ui_web` にあり、`registerViewFactory` は `registerViewFactory(String viewType, Function viewFactory, {bool isVisible = true})` と宣言されています。

   ```dart
   // Flutter 3.44.8, package:web 1.1.1
   import 'dart:ui_web' as ui_web;

   import 'package:flutter/widgets.dart';
   import 'package:web/web.dart' as web;

   const _viewType = 'startdebugging-iframe';

   void registerIframeFactory() {
     ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId) {
       final iframe = web.document.createElement('iframe') as web.HTMLIFrameElement
         ..src = 'https://startdebugging.net/'
         ..style.border = 'none'
         ..style.width = '100%'
         ..style.height = '100%';
       return iframe;
     });
   }

   class EmbeddedSite extends StatelessWidget {
     const EmbeddedSite({super.key});

     @override
     Widget build(BuildContext context) =>
         const HtmlElementView(viewType: _viewType);
   }
   ```

   検証: `flutter run -d chrome` でビューが描画され、`flutter build web --wasm` がそのファイルを問題なくコンパイルすること。

6. **条件付き import を `dart.library.js_interop` を見る形に書き換えます。** 古い書き方は `dart2wasm` では `dart.library.html` が偽になるため、黙ってスタブ実装を選び、コンパイルエラーではなく実行時の `UnsupportedError` を生みます。この移行全体で最悪の失敗モードです。

   ```dart
   // lib/platform_open.dart, Dart 3.12.2
   export 'src/open_stub.dart'
       if (dart.library.io) 'src/open_io.dart'
       if (dart.library.js_interop) 'src/open_web.dart';
   ```

   ```dart
   // lib/src/open_web.dart
   import 'package:web/web.dart' as web;

   void openUrl(String url) => web.window.open(url, '_blank');
   ```

   検証: リポジトリを `dart.library.html` で grep して 0 件であることを確認し、その後ネイティブのターゲットと Web の両方でアプリを実行して、どちらの分岐も解決されることを確かめます。同じ手法は[プラグインを使わないプラットフォーム固有コード](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)というより広い問題にも当てはまります。

7. **テストは最後に直します。モックの壊れ方が違うからです。** `package:web` の型は `JSObject` 上の extension type なので、`implements HTMLElement` と書いたフェイクはコンパイルできません。クラスベースのフェイクは、テスト内で生成した本物の DOM ノードか、自分で組み立ててテスト対象に渡す JS オブジェクトに置き換えてください。DOM のメンバーを呼ぶために `dynamic` に頼っていたコードも動かなくなります。extension type のメンバーは静的にしか解決されないからです。

   検証: `flutter test` が通り、テストスイートに `package:web` の型を指す `implements` 句が残っていないこと。

## 検証

次の 4 つをこの順で実行します。

```console
dart analyze --fatal-infos
flutter test
flutter build web
flutter build web --wasm
```

本当の関門は最後のコマンドです。移行済みのアプリでは `Built build/web` で終わり、`build/web` に `main.dart.wasm`、`main.dart.mjs`、そして `dart2js` のフォールバックである `main.dart.js` が出力されます。それでも失敗する場合は、エラーが残っている import の連鎖を正確に示してくれます。その後はアプリを読み込み、DOM に触れる箇所をひととおり操作します。ファイルのダウンロード、クリップボード、iframe、`localStorage`、そして interop 越しに会話しているすべての JS SDK です。

## ロールバック計画

ファイル単位のロールバックは簡単で、リポジトリ全体のロールバックは計画する価値がありません。`package:web` と `dart:html` は同じプログラム内で共存できるので、1 ファイルだけ移行して出荷し、問題が起きたらそのファイルだけ戻せます。できないのは、`dart:html` のコードパスを削除して Wasm ビルドを出荷した後で戻すことです。Wasm ビルドはそもそもそれらをサポートしていなかったからです。上記のクリックによる確認が終わるまでは、本番のターゲットを `dart2js` ビルドのままにしてください。`flutter build web --wasm` は両方を出力し、ローダーが自動でフォールバックします。

## 始める前に知っておきたい落とし穴

**公式の `JSImmutableListWrapper` の例はコンパイルできません。** `JSImmutableListWrapper<T, U>` はコンストラクター引数から `U` を推論できないため、境界である `JSObject` にフォールバックします。

```dart
for (final a in JSImmutableListWrapper(document.querySelectorAll('a'))) {
  a.classList.add('link'); // error: The getter 'classList' isn't defined for the type 'JSObject'
}
```

型引数は両方とも明示的に渡してください。

```dart
// package:web 1.1.1
for (final a in JSImmutableListWrapper<NodeList, Element>(
  document.querySelectorAll('a'),
)) {
  a.classList.add('link');
}
```

**`innerHTML` は読み書きの両方向で `JSAny` です。** 書き込みには `.toJS` が必要で、読み取りにはキャストが必要です。`final String s = el.innerHTML;` は "A value of type 'JSAny' can't be assigned to a variable of type 'String'" で失敗します。`(el.innerHTML as JSString).toDart` として読んでください。`outerHTML` や、第 2 引数が `JSAny` である `insertAdjacentHTML` にも同じことが当てはまります。

**`element.text` はゲッターのないセッターです。** `package:web` は移行の利便性のために非推奨の `text` セッターを残していますが、読み取りには `String` ではなく `String?` である `textContent` が必要です。`if (el.text.isEmpty)` と書いていたコードには null チェックが要ります。

**コールバックはゾーンを失います。** `dart:html` はイベントのコールバックを現在のゾーンに自動でバインドしていましたが、`package:web` はしません。ゾーンローカルな値に依存している場合や、リスナー内部で起きたことをゾーンベースのエラーハンドラーに捕捉させたい場合は、変換の前に手動でバインドしてください。

```dart
element.addEventListener(
  'click',
  Zone.current.bindUnaryCallback((Event event) {
    // zone-local values are preserved here
  }).toJS,
);
```

**型チェックは意味が静かに変わります。** `obj is Window` は `dart:html` では問題なくコンパイルできましたが、`package:web` ではすべての型が `JSObject` に消去されるため、このチェックは無意味です。`element.isA<HTMLInputElement>()` (Dart 3.4 以降) か `obj.instanceOfString('Window')` を使ってください。

**`dart:html` の習慣の一部は非推奨のシムとして生き残っています。** `window.localStorage['k'] = 'v'` は今も解析を通りますが "'[]=' is deprecated and shouldn't be used. Use Storage.setItem instead" が付き、トップレベルの `querySelector` も "Directly use document.querySelector instead" 付きで存在します。今日はコンパイルできますが、行き先ではありません。同じパスで書き換えないと、この作業を 2 回やることになります。

**イベントのストリームは健在で、こちらが使いやすい経路です。** `package:web` はストリームのヘルパーを同梱しているので、`input.onClick.listen(...)` はそのまま動き、`ElementStream<MouseEvent>` を返します。キャンセルが必要なものには、素の `addEventListener` と `.toJS` の組み合わせよりこちらを選んでください。なお、ヘルパーのストリームは `dart:html` が同期的だった一部のイベントを非同期に配信するため、タイミングに敏感なコードは見直しが必要です。

## 関連記事

- この作業の見返りは [WebAssembly で Flutter の Web アプリをビルドする](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/)で詳しく説明しています。Firefox と Safari が今も JavaScript ビルドを受け取る理由も含みます。
- 構造としては [Flutter 2 のアプリを Flutter 3.x へ移行する](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)と同種の、広く機械的なパスです。2 段階の計画と、終わったことを教えてくれるコンパイラーが揃っています。
- 手順 6 の条件付き import の仕組みは、[プラグインを使わないプラットフォーム固有コード](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)の裏側にあるものと同じです。
- 同時に Flutter も更新するなら、視覚的なリグレッションをこの移行のせいにする前に [Flutter 3.47 がデスクトップの描画をどう変えたか](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/)を読んでください。
- Web は [Dart の isolate](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) が他のどのプラットフォームとも違う挙動をする場所でもあります。同じパスで CPU 負荷の高い処理を動かす前に知っておく価値があります。

## 参考資料

- [Migrate to package:web](https://dart.dev/interop/js-interop/package-web)、dart.dev
- [Past JS interop](https://dart.dev/interop/js-interop/past-js-interop)、dart.dev
- [JS types and conversions](https://dart.dev/interop/js-interop/js-types)、dart.dev
- [Breaking changes and deprecations](https://dart.dev/resources/breaking-changes)、dart.dev
- [pub.dev の package:web](https://pub.dev/packages/web)、バージョン 1.1.1
- [EventStreamProviders の API リファレンス](https://pub.dev/documentation/web/latest/web/EventStreamProviders-class.html)、package:web
- [dart:ui_web PlatformViewRegistry](https://api.flutter.dev/flutter/dart-ui_web/PlatformViewRegistry-class.html)、Flutter API ドキュメント
- [Announcing Dart 3.13](https://dart.dev/blog/announcing-dart-3-13)、Dart のブログ

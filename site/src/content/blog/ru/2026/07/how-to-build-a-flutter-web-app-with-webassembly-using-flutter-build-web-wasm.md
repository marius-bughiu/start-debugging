---
title: "Как собрать веб-приложение Flutter с WebAssembly через flutter build web --wasm"
description: "Полное руководство по публикации веб-приложения Flutter, скомпилированного в WebAssembly, на Flutter 3.44: как выглядят две выпускаемые сборки, почему Firefox и Safari по-прежнему получают JavaScript из-за wasmAllowList в загрузчике, миграция с dart:html для dart2wasm, заголовки COOP/COEP, определяющие, работает ли skwasm в несколько потоков, и как в среде выполнения доказать, какую сборку реально загрузил браузер."
pubDate: 2026-07-28
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webassembly"
  - "flutter-web"
  - "performance"
  - "how-to"
lang: "ru"
translationOf: "2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm"
translatedBy: "claude"
translationDate: 2026-07-28
---

Чтобы собрать веб-приложение Flutter с WebAssembly, добавьте флаг `--wasm`: `flutter build web --wasm`. Этот единственный флаг заставляет инструмент выпустить в `build/web` *две* сборки: сборку WasmGC, скомпилированную `dart2wasm` и использующую рендерер `skwasm`, и обычную сборку `dart2js`, использующую `canvaskit` как резервную. Сгенерированный `flutter_bootstrap.js` выбирает одну из них при загрузке страницы. Дальше то, получат ли реальные пользователи сборку Wasm, определяют две вещи: ничто в графе зависимостей не должно импортировать `dart:html`, `dart:js`, `dart:js_util` или `package:js`, а сервер обязан отдавать `Cross-Origin-Opener-Policy: same-origin` вместе с `Cross-Origin-Embedder-Policy: credentialless`, иначе `skwasm` молча переходит на один поток. Статья ориентирована на [Flutter 3.44](/ru/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) stable (выпущен 2026-05-18, включает Dart 3.10), и каждая деталь ниже проверена по ветке `stable` репозитория `flutter/flutter`. Важная оговорка сразу: начиная с 3.44 загрузчик включает сборку Wasm только в браузерах на Blink, поэтому Firefox, Safari и любой браузер на iOS получают сборку JavaScript независимо от того, что вы скомпилировали.

## Что `--wasm` на самом деле кладёт в build/web

Мысленная модель, которая есть у большинства, неверна довольно полезным образом. `--wasm` не переключает сборку с JavaScript на WebAssembly. Он *добавляет* сборку WebAssembly рядом с JavaScript-сборкой. В `packages/flutter_tools/lib/src/commands/build_web.dart` передача флага создаёт список из двух конфигураций компилятора, `WasmCompilerConfig` и `JsCompilerConfig`, и инструмент запускает оба компилятора. Без флага вы получаете настоящий `JsCompilerConfig` плюс `WasmCompilerConfig`, помеченный `dryRun: true`, который компилирует, но выбрасывает результат (об этом чуть ниже).

Каждая скомпилированная цель добавляет описание сборки в сгенерированный `flutter_bootstrap.js`. После `flutter build web --wasm` на Flutter 3.44 дескриптор выглядит так:

```javascript
// Excerpt from build/web/flutter_bootstrap.js, Flutter 3.44 stable
if (!window._flutter) {
  window._flutter = {};
}
_flutter.buildConfig = {
  "engineRevision": "...",
  "builds": [
    {
      "compileTarget": "dart2wasm",
      "renderer": "skwasm",
      "mainWasmPath": "main.dart.wasm",
      "jsSupportRuntimePath": "main.dart.mjs"
    },
    {
      "compileTarget": "dart2js",
      "renderer": "canvaskit",
      "mainJsPath": "main.dart.js"
    }
  ]
};
```

Порядок важен: `FlutterLoader.load()` вызывает `buildConfig.builds.find(buildIsCompatible)` и берёт *первую* совместимую запись, поэтому сборка Wasm выигрывает всегда, когда это позволяет окружение. Привязка рендерера не настраивается. `WebRendererMode.defaultForWasm` равно `skwasm`, а `defaultForJs` равно `canvaskit`, и инструмент не позволяет их смешивать, что даёт первый подводный камень из списка ниже.

На диске вы получаете `main.dart.wasm` (сам модуль), `main.dart.mjs` (JS-среда поддержки, которая его инстанцирует) и `main.dart.js` (резервный вариант), а также полезную нагрузку рендереров: `skwasm.js` и `skwasm.wasm` для пути Wasm и бандл CanvasKit для резервного пути.

## Пять шагов, которые действительно важны

1. **Перейдите на Flutter 3.24 или новее.** Компиляция в Wasm попала в stable в 3.24; здесь я проверял на 3.44. Если вы жонглируете версиями SDK по проектам, мои заметки о [запуске одного проекта Flutter на нескольких версиях SDK в CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) применимы к сборкам Wasm без изменений.
2. **Пересоздайте `web/index.html`, если он старше Flutter 3.22.** Путь Wasm полностью опирается на загрузчик `flutter_bootstrap.js`, поэтому старый bootstrap с `serviceWorkerVersion` работать не будет. `flutter create . --platforms web` после удаления `web/` даёт актуальный шаблон.
3. **Уберите из графа зависимостей несовместимости с `dart2wasm`.** Сначала соберите через `flutter build web` без `--wasm` и прочитайте выводы dry run.
4. **Соберите:** `flutter build web --wasm`.
5. **Раздавайте с заголовками кросс-доменной изоляции.** Без них приложение всё равно работает, но в один поток, что обесценивает большую часть смысла Wasm.

## Почему приложение всё ещё выполняет JavaScript в Firefox и Safari

Именно это удивляет разработчиков, а официальная страница поддержки Wasm устарела достаточно (её frontmatter `last-update` указывает Nov 6, 2024), чтобы её чтение не объясняло текущее поведение. WasmGC уже не является ограничением: он достиг Baseline в Chrome 119, Firefox 120 и Safari 18.2. Ограничение находится в жёстко заданном списке разрешений внутри загрузчика движка.

Файл `engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js` в ветке `stable` содержит ровно это:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js
export const defaultWasmSupport = {
  "blink": true,
  "gecko": false,
  "webkit": false,
  "unknown": false,
}
```

А `loader.js` ставит сборку `skwasm` в зависимость от этого списка:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/loader.js
const supportsDart2Wasm = browserEnvironment.supportsWasmGC;
const supportsSkwasm = supportsDart2Wasm && browserEnvironment.webGLVersion > 0;

const enableWasm = config.wasmAllowList?.[browserEnvironment.browserEngine]
  ?? defaultWasmSupport[browserEnvironment.browserEngine];
```

Поэтому в Firefox `supportsWasmGC()` возвращает `true` (детектор валидирует крошечный модуль WasmGC, и Firefox его проходит), но `enableWasm` из записи `gecko` даёт `false`, сборка `skwasm` отклоняется как несовместимая, и загрузчик переходит к `dart2js` + `canvaskit`. С Safari через `webkit` та же история. Причина не в WasmGC, а в рендерере: многопоточный `skwasm` во Flutter опирается на `OffscreenCanvas.transferToImageBitmap`, и баг Firefox (Bugzilla 1788206), и баг WebKit (267291), отслеживающие его стоимость, на момент проверки в июле 2026 года оставались открытыми.

Список разрешений можно переопределить самому, и это стоит делать за параметром запроса, если нужны реальные цифры, а не мнения:

```javascript
// web/flutter_bootstrap.js, Flutter 3.44
{{flutter_js}}
{{flutter_build_config}}

const params = new URLSearchParams(window.location.search);
_flutter.loader.load({
  config: {
    // Only opt gecko/webkit in deliberately. Expect rendering artifacts.
    wasmAllowList: params.has('force_wasm')
      ? { blink: true, gecko: true, webkit: true, unknown: false }
      : undefined,
  },
});
```

Не отправляйте это в production по интуиции. Сначала измерьте по методике из статьи о [профилировании jank во Flutter-приложении с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/), потому что на затронутых движках отказ проявляется как деградация времени кадра, а не как аккуратная ошибка.

Одно ограничение не переопределяется вообще: все браузеры на iOS обязаны использовать WebKit, поэтому скомпилированное в Wasm приложение Flutter не может работать в iOS Safari, iOS Chrome и ни в чём другом на этой платформе.

## Как заставить зависимости компилироваться

`dart2wasm` поддерживает только статический JS-интероп Dart. Любой транзитивный импорт `dart:html`, `dart:js`, `dart:js_util` или `package:js` рушит компиляцию с сообщениями вроде этих:

```output
Dart library 'dart:html' is not available on this platform.
JS interop library 'dart:js_util' can't be imported when compiling to Wasm.
Try using 'dart:js_interop' or 'dart:js_interop_unsafe' instead.
```

Хорошая новость: выяснять это методом проб не нужно. `--wasm-dry-run` по умолчанию равен `true`, поэтому обычный `flutter build web` уже запускает `dart2wasm` в режиме dry run и сообщает найденное:

```output
Wasm dry run findings:
...
Consider addressing these issues to enable wasm builds. See docs for more info:
https://docs.flutter.dev/platform-integration/web/wasm
```

Если приложение уже чистое, тот же механизм подталкивает в обратную сторону сообщением `Wasm dry run succeeded. Consider building and testing your application with the --wasm flag.` В любом случае `flutter build web --no-wasm-dry-run` отключает вывод, когда решение принято.

Для своего кода миграция состоит в переходе на `package:web` вместо `dart:html` и на `dart:js_interop` вместо `package:js`:

```dart
// Dart 3.10, Flutter 3.44 -- wasm-compatible
import 'dart:js_interop';
import 'package:web/web.dart' as web;

@JS('navigator.clipboard.writeText')
external JSPromise<JSAny?> _writeText(String text);

Future<void> copy(String text) async {
  await _writeText(text).toDart;
  web.document.querySelector('#status')?.textContent = 'Copied';
}
```

При миграции больно бьют три различия. Имена следуют браузерному IDL, поэтому `HtmlElement` становится `HTMLElement`, а `innerHtml` становится `innerHTML`. `querySelectorAll` возвращает итерируемый объект, который не является `List`. И поскольку типы интеропа являются extension types, `is` и `as` работают не так, как вы ожидаете; используйте вместо них `isA<T>()`. Условные импорты тоже меняются: теперь условием служит `dart.library.js_interop`, а не `dart.library.html`. Если вы пишете интероп руками, а не подключаете плагин, приёмы из статьи о [добавлении платформозависимого кода во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) переносятся напрямую.

Для чужого кода фильтруйте pub.dev по `is:wasm-ready`. Когда блокирует зависимость, её обновление часто и есть всё решение, и добавляется обычная боль с разрешением ограничений; если вы попали в ад резолвера, выход описан в статье [Исправление: Version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## COOP и COEP определяют, получите ли вы потоки

Flutter компилирует `skwasm` с разделяемой памятью. Это видно в вызове компилятора в `build_system/targets/web.dart`, который для рендерера `skwasm` добавляет `--import-shared-memory` и `--shared-memory-max-pages=32768`. Разделяемая память в браузере требует кросс-доменной изоляции, а та требует двух заголовков ответа. Инструмент жёстко задаёт нужную пару:

```dart
// packages/flutter_tools/lib/src/web/web_constants.dart, Flutter 3.44
const kCrossOriginIsolationHeaders = <String, String>{
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};
```

`flutter run -d chrome --wasm` выставляет их на своём сервере разработки, и именно поэтому проблема никогда не проявляется локально, а потом проявляется в production. При их отсутствии ошибки не будет. `skwasm_loader.js` вычисляет `skwasmSingleThreaded: ... || !browserEnvironment.crossOriginIsolated || ...` и молча запускает однопоточный движок.

Для nginx:

```nginx
# nginx, serving build/web
location / {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
    try_files $uri $uri/ /index.html;
}
```

Для Firebase Hosting:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
          { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
        ]
      }
    ]
  }
}
```

Проверьте в консоли браузера `window.crossOriginIsolated`: значение должно быть `true`. Учтите, что GitHub Pages вообще не умеет отдавать пользовательские заголовки, поэтому размещённая там сборка Wasm всегда будет работать в один поток.

Кросс-доменная изоляция не бесплатна. `require-corp` ломает любой кросс-доменный подресурс, который не согласился через `Cross-Origin-Resource-Policy`, а на практике это сторонние изображения, шрифты, аналитические beacon-запросы и встроенные iframe. `credentialless` мягче: он загружает кросс-доменные подресурсы без учётных данных, а не блокирует их. Начните с `credentialless`, а затем просмотрите панель сети в поисках запросов, потерявших свои cookie.

## Как доказать, какую сборку загрузил браузер

Не выводите это по секундомеру. Компилятор задаёт переменную окружения, которую можно прочитать:

```dart
// Flutter 3.44, Dart 3.10
const isRunningWithWasm = bool.fromEnvironment('dart.tool.dart2wasm');
```

Есть и поведенческая проверка, работающая без пересборки и основанная на том, что Wasm использует нативное представление чисел:

```dart
final isRunningWithWasm = identical(double.nan, double.nan);
```

Панель сети служит третьей проверкой: запрос `main.dart.wasm` означает сборку Wasm, `main.dart.js` означает резервную.

## Подводные камни, о которых стоит знать до публикации

**Указание рендерера вместе с `--wasm` является жёсткой ошибкой.** `build_web.dart` вызывает `throwToolExit('Do not attempt to set a web renderer when using "--wasm"')`, когда вычисленный рендерер не равен `skwasm`. Поэтому `--wasm` в комбинации с `--dart-define=FLUTTER_WEB_USE_SKIA=true` падает на уровне CLI, и так задумано.

**`config.renderer: 'canvaskit'` в сборке Wasm падает в среде выполнения.** `buildIsCompatible` отклоняет любую сборку, чей `renderer` не равен настроенному значению, а сборка `--wasm` не содержит записи `dart2wasm` + `canvaskit`. Все кандидаты отфильтровываются, и загрузчик выбрасывает `FlutterLoader could not find a build compatible with configuration and environment.` Это отслеживается как flutter/flutter#183265. Уберите ключ `renderer` либо установите его в `skwasm`.

**Движки не на Chromium загружают более тяжёлую полезную нагрузку рендерера.** `loadSkwasm` выбирает `skwasm_heavy` вместо `skwasm`, когда в браузере нет `ImageDecoder` или разрывателей строк Chromium, поэтому при принудительном открытии списка разрешений вы дополнительно платите увеличенной загрузкой.

**Расширения Chrome принудительно переводятся в один поток.** Загрузчик обнаруживает `chrome.runtime.id` и отключает потоки, потому что CSP расширений блокирует динамическую загрузку скриптов, нужную воркерам.

**Имена символов по умолчанию удаляются.** `--strip-wasm` по умолчанию равен `true`. Передавайте `--no-strip-wasm`, когда нужна читаемая трассировка стека из профилировочной сборки, и `--source-maps`, чтобы получить `main.dart.wasm.map`.

**Wasm не решает проблему SEO.** Обе сборки рисуют на canvas, поэтому краулеры по-прежнему видят почти полное отсутствие семантического HTML. Wasm делает веб-приложение Flutter быстрее; документом оно от этого не становится.

**Инструмент всё ещё называет это новым.** `flutter build web --wasm` печатает рамку с текстом `WebAssembly compilation is new. Understand the details before deploying to production.` Считайте это точным утверждением, а не формальностью: фиксируйте версию Flutter и держите резервный путь на JavaScript в матрице тестирования, потому что при нынешнем списке разрешений именно на этом пути находится большинство ваших пользователей.

## Похожие статьи

- [Как профилировать jank во Flutter-приложении с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)
- [Как добавить платформозависимый код во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Как нацелиться на несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Исправление: Version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Миграция приложения Flutter 2 на Flutter 3.x: чек-лист по null safety](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Источники

- Документация Flutter, [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm)
- Документация Flutter, [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization)
- Документация Flutter, [Build and release a web app](https://docs.flutter.dev/deployment/web)
- Исходный код Flutter, [`packages/flutter_tools/lib/src/commands/build_web.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_web.dart)
- Исходный код Flutter, [`engine/src/flutter/lib/web_ui/flutter_js/src/loader.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js) и [`browser_environment.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js)
- Issue Flutter [#183265, FlutterLoader could not find a build compatible with configuration and environment](https://github.com/flutter/flutter/issues/183265)
- Документация Dart, [Migrate to package:web](https://dart.dev/interop/js-interop/package-web) и [WebAssembly (Wasm) compilation](https://dart.dev/web/wasm)
- web.dev, [WasmGC and Wasm tail call optimizations are now Baseline Newly available](https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline)
- Chrome for Developers, [COEP: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial)

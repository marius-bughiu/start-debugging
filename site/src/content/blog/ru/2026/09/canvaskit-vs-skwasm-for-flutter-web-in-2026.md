---
title: "CanvasKit или skwasm для Flutter web в 2026 году: какой рендерер выпускать?"
description: "Выпускайте skwasm через flutter build web --wasm, если ваши зависимости компилируются в Wasm: он загружает меньше и на тяжёлой сцене отрисовал на 36% больше кадров, чем CanvasKit. На Flutter 3.47.x оставайтесь в однопоточном режиме, пока исправление падения многопоточного режима на тексте не выйдет из beta."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "flutter"
  - "flutter-web"
  - "webassembly"
  - "performance"
lang: "ru"
translationOf: "2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026"
translatedBy: "claude"
translationDate: 2026-09-17
---

Выпускайте skwasm. На Flutter 3.47.4 (текущий stable, Dart 3.13.3) `flutter build web --wasm` даёт пользователям Chromium меньший объём загрузки (1.65 MB против 1.98 MB в brotli для тестового приложения ниже) и 32.7 кадра в секунду против 24.0 у CanvasKit на тяжёлой сцене. Firefox, Safari и все браузеры на iOS по-прежнему получают CanvasKit из той же сборки. Оставаться на сборке только с CanvasKit стоит лишь в том случае, если какая-то зависимость всё ещё импортирует `dart:html` или `package:js`. Одна оговорка для 3.47.x: многопоточный skwasm может падать на кадрах с большим количеством текста, поэтому принудительно включайте однопоточный режим, пока 3.48 не дойдёт до stable.

Слово "рендерер" здесь немного вводит в заблуждение, потому что CanvasKit или skwasm сами по себе не выбираются. С тех пор как Flutter 3.29 удалил HTML-рендерер и флаг `--web-renderer`, рендерер определяется целью компиляции. Результат `dart2js` всегда работает на CanvasKit, а результат `dart2wasm` всегда работает на skwasm. Инструмент это жёстко проверяет: `flutter build web --wasm --dart-define=FLUTTER_WEB_USE_SKIA=true --dart-define=FLUTTER_WEB_USE_SKWASM=false` завершается с ошибкой `Do not attempt to set a web renderer when using "--wasm"`. Так что настоящий вопрос звучит как "сборка на JavaScript или сборка на Wasm", и ответ на него определяет, какой Skia работает под капотом.

## Матрица возможностей

| Свойство (Flutter 3.47.4)          | CanvasKit                                           | skwasm                                                        |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Цель компиляции                    | `dart2js`                                           | `dart2wasm` (нужен WasmGC)                                    |
| Команда сборки                     | `flutter build web`                                 | `flutter build web --wasm` (также создаёт сборку CanvasKit)   |
| Браузеры, загружающие его по умолчанию | Все                                             | Только Blink (Chrome, Edge, Opera, Chrome на Android)          |
| Загрузка движка, brotli            | 1.54 MB (вариант Chromium), 2.26 MB (полный вариант) | 1.21 MB (`skwasm.wasm`), 1.86 MB (`skwasm_heavy.wasm`)        |
| Где идёт растеризация              | Главный поток                                       | Web Worker, если страница изолирована от других источников (cross-origin isolated) |
| Заголовки для лучшего режима       | Не нужны                                            | `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` |
| `dart:html`, `package:js` в графе  | Без проблем                                         | Ошибка компиляции                                             |
| Отладка через `flutter run -d chrome` | Полноценные DevTools, hot reload с сохранением состояния (DDC) | Нет service protocol, hot reload работает как перезапуск |
| Отложенная загрузка                | Да                                                  | Выключена по умолчанию, экспериментальный флаг запланирован на 3.50 |
| Известная проблема в канале stable | Блокирующих нет                                     | Падение многопоточного режима при частой смене текста, #190039 |

Две строки требуют пояснения. Строка "Только Blink" не связана с поддержкой WasmGC: и Firefox, и Safari уже сегодня проходят валидацию WasmGC. Загрузчик Flutter не пускает их на skwasm с помощью жёстко заданного списка разрешённых браузеров в `browser_environment.js` (`blink: true, gecko: false, webkit: false`). Причина в том, что многопоточный skwasm передаёт кадры из воркера на страницу через `OffscreenCanvas.transferToImageBitmap`, а в обоих движках это медленно. Соответствующие баги, [Mozilla 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) и [WebKit 267291](https://bugs.webkit.org/show_bug.cgi?id=267291), в сентябре 2026 года всё ещё находились в статусе `NEW`.

Строка про отладку взята прямо из `resident_web_runner.dart` версии 3.47.4: `supportsServiceProtocol` равно `!debuggingOptions.webUseWasm && isRunningDebug && ...`, а `reloadIsRestart` возвращает `true` всякий раз, когда задан `webUseWasm`. Поэтому повседневная разработка остаётся на пути JavaScript даже у команд, которые выпускают Wasm.

## Что на самом деле загружает каждая сборка

Сборка с `--wasm` записывает оба конвейера в `build/web`, а `flutter_bootstrap.js` содержит `buildConfig`, где они перечислены в порядке приоритета:

```jsonc
// flutter build web --wasm, Flutter 3.47.4
"builds": [
  {"compileTarget": "dart2wasm", "renderer": "skwasm", "mainWasmPath": "main.dart.wasm", "jsSupportRuntimePath": "main.dart.mjs"},
  {"compileTarget": "dart2js", "renderer": "canvaskit", "mainJsPath": "main.dart.js"}
]
```

Загрузчик берёт первую совместимую запись. Затем внутри каждого рендерера он выбирает вариант в зависимости от возможностей браузера. `canvaskit_loader.js` загружает `canvaskit/chromium/canvaskit.wasm`, если у браузера есть и `ImageDecoder`, и `Intl.v8BreakIterator`. Этот вариант оставляет кодеки изображений и данные ICU браузеру, а Flutter 3.47.0 убрал из него оставшиеся кодеки ([#178133](https://github.com/flutter/flutter/pull/178133)). Все остальные получают полный `canvaskit.wasm`. У `skwasm_loader.js` такое же разделение: `skwasm.wasm` в Chromium и более крупный `skwasm_heavy.wasm` везде, где этих двух API нет. На практике `skwasm_heavy` встречается только тогда, когда вы переопределяете список разрешённых браузеров, чтобы перевести Firefox или Safari на Wasm.

Я измерил, во что обходится первое посещение на каждом пути, используя release-сборку тестового приложения, описанного ниже (Material-приложение примерно на 180 строк). Размеры указаны для `brotli -q 11` и `gzip -9` файлов, которые загружает каждый путь. `flutter.js`, `flutter_bootstrap.js`, шрифты и ресурсы одинаковы на всех путях, поэтому они не учитываются:

| Путь (Flutter 3.47.4)       | Код приложения                        | JS + Wasm рендерера | Итого brotli | Итого gzip |
| --------------------------- | ------------------------------------- | ------------------ | ------------ | ---------- |
| CanvasKit, вариант Chromium | `main.dart.js` 413 KB                 | 1,564 KB           | **1,977 KB** | 2,612 KB   |
| CanvasKit, полный вариант   | `main.dart.js` 413 KB                 | 2,281 KB           | **2,695 KB** | 3,465 KB   |
| skwasm                      | `main.dart.wasm` 416 KB + `.mjs` 6 KB | 1,225 KB           | **1,647 KB** | 2,083 KB   |

При таком размере код приложения выходит вничью: 1.42 MB сырого Wasm и 1.79 MB сырого минифицированного JavaScript сжимаются в brotli почти до одного и того же размера. Экономия достигается за счёт движка, поскольку `skwasm.wasm` примерно на 330 KB меньше, чем CanvasKit для Chromium. Одна оговорка для больших приложений: `dart2wasm` по умолчанию не разделяет отложенные импорты, поэтому приложение, которое полагается на `deferred as`, чтобы первая загрузка оставалась небольшой, на пути Wasm может это преимущество потерять.

## Бенчмарк

Размер загрузки описывает только половину картины. Вторая половина это время кадра, поэтому я отрисовал одни и те же сцены во всех конфигурациях.

**Окружение.** Apple M4, 16 GB RAM, macOS 26. Google Chrome 153.0.8010.48, запущенный с `--headless=new --use-angle=metal` (WebGL сообщал `ANGLE Metal Renderer: Apple M4`), окно 1280x800 при DPR 1 и новый профиль на каждый прогон. Приложение собиралось в режиме release на Flutter 3.47.4 и на 3.48.0-0.5.pre командой `flutter build web --wasm --no-web-resources-cdn` и отдавалось с localhost с `Cache-Control: no-store`. Один порт отправлял `Cross-Origin-Opener-Policy: same-origin` и `Cross-Origin-Embedder-Policy: require-corp`, другой не отправлял ни того, ни другого.

**Методика.** Одна сборка с `--wasm` обслуживала все конфигурации. Собственный `flutter_bootstrap.js` считывал рендерер из строки запроса, так что прогоны CanvasKit использовали ровно тот же резервный `main.dart.js`, который загружают реальные пользователи Firefox:

```js
// web/flutter_bootstrap.js, Flutter 3.47.4
{{flutter_js}}
{{flutter_build_config}}
const q = new URLSearchParams(location.search);
const config = {suppressMultithreadingWarning: true};
if (q.get('renderer')) config.renderer = q.get('renderer');   // 'skwasm' or 'canvaskit'
if (q.get('st')) config.forceSingleThreadedSkwasm = true;
if (q.get('variant')) config.canvasKitVariant = q.get('variant'); // 'full' to skip the Chromium variant
_flutter.loader.load({config});
```

Внутри приложения `SchedulerBinding.instance.addTimingsCallback` собирал `FrameTiming` в течение 10 секунд после 3-секундного прогрева. В вебе их записывает `FrameTimingRecorder` движка вокруг каждого вызова `draw` растеризатора. "Показанные fps" это количество замеров (кадров, завершивших растеризацию) в секунду, а каждая ячейка представляет собой медиану 3 прогонов (5 для многопоточного skwasm на 3.48). На 3.48.0-0.5.pre CanvasKit (24.0 fps) и однопоточный skwasm (32.3 fps) оказались в пределах 2% от своих результатов на 3.47.4, поэтому в таблицах приведены данные 3.47.4 везде, где эта версия отработала без проблем. Сцена "tiles" состоит из 600 вращающихся `Container` с градиентом, скруглёнными углами, `BoxShadow` и `Text`, содержимое которого меняется каждый кадр. Сцена "paths" это `CustomPainter`, который обводит 400 анимированных контуров из 40 сегментов.

**Сцена tiles (тяжёлая):**

| Конфигурация                           | Показанные fps | Build p50 | Raster p50 | Frame span p90 | Первый кадр |
| -------------------------------------- | ------------- | --------- | ---------- | -------------- | ----------- |
| CanvasKit, вариант Chromium (3.47.4)   | 24.0          | 24.2 ms   | 17.1 ms    | 44.0 ms        | 285 ms      |
| CanvasKit, полный вариант (3.47.4)     | 24.3          | 23.7 ms   | 17.2 ms    | 42.9 ms        | 286 ms      |
| skwasm, однопоточный (3.47.4)          | **32.7**      | 13.6 ms   | 16.0 ms    | 31.4 ms        | 193 ms      |
| skwasm, многопоточный (3.47.4)         | завис         | n/a       | n/a        | n/a            | 245 ms      |
| skwasm, многопоточный (3.48.0-0.5.pre) | **39.3**      | 14.7 ms   | 22.5 ms    | 48.0 ms        | 238 ms      |

**Сцена paths (лёгкая):**

| Конфигурация (3.47.4)       | Показанные fps | Build p50 | Raster p50 |
| --------------------------- | ------------- | --------- | ---------- |
| CanvasKit, вариант Chromium | 60.4          | 3.3 ms    | 3.0 ms     |
| skwasm, однопоточный        | 60.0          | 1.2 ms    | 3.9 ms     |
| skwasm, многопоточный       | 59.9          | 1.1 ms    | 4.1 ms     |

Выделяются четыре вещи:

1. **Основной выигрыш даёт `dart2wasm`, а не Skia.** Время растеризации почти одинаковое (17.1 ms против 16.0 ms на tiles, а на paths CanvasKit даже быстрее). Фаза build, то есть ваш код виджетов, раскладки и отрисовки на Dart, при компиляции в WasmGC работает примерно в два раза быстрее. Чем больше работы фреймворка приходится на кадр, тем больше разрыв.
2. **Многопоточность меняет задержку на пропускную способность.** На beta 3.48 многопоточная сборка показала на 22% больше кадров, чем однопоточная (39.3 против 32.3 fps), при этом её raster p50 вырос до 22.5 ms. UI-поток собирает следующий кадр, пока воркер ещё растеризует предыдущий. `Renderer.renderScene` оставляет только самую новую ожидающую сцену и отбрасывает остальные. В итоге кадров в целом больше, а каждый кадр длится дольше.
3. **Лёгкие сцены в любом случае упираются в vsync.** Если ваше приложение состоит из форм и списков, разницы между рендерерами в частоте кадров вы не увидите. Вы увидите разницу в размере загрузки и во времени запуска.
4. **Первый кадр на localhost у однопоточного skwasm появляется примерно на 90 ms раньше** (193 ms против 285 ms; в многопоточном режиме запуск воркера рендеринга частично съедает это преимущество). Без учёта сети этот разрыв складывается из стоимости компиляции и инстанцирования. На реальном соединении к нему добавляется разница в 330 KB в brotli.

Абсолютные числа относятся именно к M4 с Metal. Переносятся на другие условия соотношения.

## Когда выбирать skwasm

- **Ваша аудитория в основном использует десктопные Chrome или Edge либо Chrome на Android.** Именно эти пользователи получают сборку Wasm, и меньший объём загрузки и более быстрая фаза build достаются им бесплатно. Все остальные прозрачно откатываются на CanvasKit.
- **Ваши кадры нагружают фреймворк.** Дашборды, таблицы данных и анимированные списки тратят время на build и раскладку, а именно там `dart2wasm` вырвался вперёд в бенчмарке.
- **Вы управляете заголовками ответа.** Многопоточному режиму нужны `Cross-Origin-Opener-Policy: same-origin` и `Cross-Origin-Embedder-Policy: credentialless` (или `require-corp`). Без них skwasm всё равно работает в однопоточном режиме и пишет предупреждение, которое можно отключить через `suppressMultithreadingWarning: true`.
- **Весь ваш граф зависимостей переведён на `package:web` и `dart:js_interop`.** Обычный `flutter build web` при каждой сборке выполняет пробный прогон Wasm и выводит "Wasm dry run succeeded" или список проблемных импортов, так что вы уже это знаете.

## Когда выбирать CanvasKit

- **Какая-то зависимость всё ещё импортирует `dart:html`, `dart:js` или `package:js`.** `dart2wasm` отказывается её компилировать, так что выбор сделан за вас, пока этот пакет не мигрирует.
- **Большая часть вашего трафика приходится на iOS или Safari.** Эти пользователи всё равно получают CanvasKit из сборки с `--wasm`. Сборка Wasm лишь добавляет время сборки и второй конвейер для тестирования, не давая им никакой пользы.
- **Вы встраиваете контент с других источников и не можете внедрить COEP.** Сторонние iframe, рекламные скрипты или изображения без заголовков CORS могут сломаться при `require-corp`, а `credentialless` удаляет cookie из таких запросов. Однопоточному skwasm заголовки не нужны, но вы теряете прирост пропускной способности.
- **Вам нужна отложенная загрузка ради размера первой загрузки.** Пока отложенная загрузка в Wasm не выйдет из-под экспериментального флага, сборка на JavaScript с импортами `deferred as` может стартовать с меньшим объёмом, чем монолитный `main.dart.wasm`.

## Подвох, который делает выбор за вас на 3.47.x

В сцене tiles многопоточный skwasm на Flutter 3.47.4 зависал в 6 из 7 прогонов. В четырёх из них `requestAnimationFrame` продолжал срабатывать, а фреймворк продолжал выполнять build на 60 fps, но после первых кадров ни одного `FrameTiming` не приходило, так что ничего нового на экран не попадало. В двух других страница полностью перестала выполнять таймеры Dart. Консоль Chrome в одних прогонах показывала `Uncaught RuntimeError: null function` и `table index is out of bounds` из `skwasm.wasm`, а в других вообще ничего. Та же сцена в однопоточном режиме и сцена paths без текста в многопоточном режиме каждый раз отрабатывали без проблем.

Это совпадает с [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039). Согласно описанию исправления, многопоточный skwasm собирается с `-sWASM_WORKERS`, но без `-pthread`, поэтому он линкуется с однопоточными системными библиотеками emscripten, где мьютексы ничего не делают. Раскладка текста в главном потоке и воркер растеризации в результате совместно используют глобальный `SkStrikeCache` из Skia и повреждают кучу, когда текст меняется каждый кадр. Исправление, [PR #190048](https://github.com/flutter/flutter/pull/190048) ("Use thread local strike caches in skwasm"), было влито 2026-08-05 и входит в 3.48.0-0.5.pre. Когда то же приложение было пересобрано на этой beta, 5 из 5 прогонов прошли стабильно и без `RuntimeError`. Запрос на cherry-pick в stable ([#192115](https://github.com/flutter/flutter/pull/192115)) закрыли без слияния 2026-09-01, и ни один релиз 3.47.x вплоть до 3.47.4 этого исправления не содержит.

Пока вы не перешли на stable 3.48, сохраняйте сборку Wasm и отключите многопоточность в `web/flutter_bootstrap.js`:

```js
// web/flutter_bootstrap.js, Flutter 3.47.x: avoid #190039
{{flutter_js}}
{{flutter_build_config}}
_flutter.loader.load({
  config: {
    forceSingleThreadedSkwasm: true,
    suppressMultithreadingWarning: true,
  },
});
```

Однопоточный skwasm всё равно обошёл CanvasKit на 36% по показанным кадрам, так что вы теряете бонус от многопоточности, но не выигрыш от Wasm. Отказ от заголовков COOP/COEP даёт тот же эффект, но флаг в конфигурации проще откатить позже.

В той же конфигурации есть два запасных выхода, о которых стоит знать. `renderer: 'canvaskit'` заставляет загрузчик пропустить запись Wasm и загрузить сборку `dart2js`. В моих прогонах на 3.47.4 это работало со сборкой `--wasm` и выдавало `dart.tool.dart2wasm == false`, так что переключатель через строку запроса, как в примере выше, даёт вам аварийный выключатель для продакшена. А `verboseBuildSelection: true` (появился в 3.47.0) записывает в журнал, почему каждая сборка-кандидат была пропущена, и это самый быстрый способ ответить на вопрос "почему этот пользователь на CanvasKit".

## Рекомендация ещё раз

Собирайте через `flutter build web --wasm` и позвольте загрузчику отдавать skwasm браузерам Chromium, а CanvasKit всем остальным. На 3.47.x добавьте `forceSingleThreadedSkwasm: true` и уберите его, когда перейдёте на stable 3.48 с настроенными заголовками COOP/COEP. Откатывайтесь на обычную сборку CanvasKit только тогда, когда какая-то зависимость блокирует `dart2wasm`. Движки растеризуют примерно с одинаковой скоростью. На самом деле вы выбираете `dart2wasm` для собственного кода на Dart, и в 2026 году это более быстрый и компактный вариант везде, где браузер это позволяет.

## Связанные материалы

- [Как собрать веб-приложение Flutter с WebAssembly](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) подробно разбирает сборку с `--wasm` от начала до конца, включая то, как проверить, какую сборку загрузил браузер.
- [Миграция веб-приложения Flutter с `dart:html` на `package:web`](/ru/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/) необходима в первую очередь, если пробный прогон Wasm находит проблемы в вашем коде.
- [Исправление: Flutter web отдаёт устаревшую закешированную сборку после перезагрузки](/ru/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) описывает заголовки `Cache-Control`, которые находятся рядом с COOP/COEP в той же конфигурации хостинга.
- [Flutter 3.47 делает Impeller рендерером по умолчанию на десктопе](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) рассказывает о другой смене рендерера в том же релизе.

## Источники

- [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm): поддержка браузеров, необходимые заголовки, флаг отложенной загрузки.
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `canvasKitVariant`, `forceSingleThreadedSkwasm` и другие параметры конфигурации загрузчика.
- Исходный код загрузчика и движка версии 3.47.4: [`browser_environment.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js), [`loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js), [`skwasm_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/skwasm_loader.js), [`canvaskit_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/canvaskit_loader.js).
- Исходный код инструментов версии 3.47.4: [`build_web.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/commands/build_web.dart), [`compile.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/web/compile.dart), [`resident_web_runner.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/isolated/resident_web_runner.dart).
- [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039), [PR #190048](https://github.com/flutter/flutter/pull/190048) и [PR #192115](https://github.com/flutter/flutter/pull/192115): падение многопоточного skwasm, его исправление и закрытый cherry-pick в stable.
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0): `verboseBuildSelection`, удаление кодеков из варианта CanvasKit для Chromium.
- [PR #159314](https://github.com/flutter/flutter/pull/159314): удаление флага `--web-renderer`.
- [Mozilla bug 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) и [WebKit bug 267291](https://bugs.webkit.org/show_bug.cgi?id=267291): почему Firefox и Safari не входят в список разрешённых для Wasm.

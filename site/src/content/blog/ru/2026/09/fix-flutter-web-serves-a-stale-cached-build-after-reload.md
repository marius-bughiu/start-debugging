---
title: "Исправление: Flutter web отдаёт устаревшую закешированную сборку после перезагрузки вкладки браузера"
description: "Перезагрузка перепроверяет только index.html, поэтому main.dart.js без хеша в имени продолжает браться из кеша браузера. Отдавайте результат сборки Flutter с Cache-Control: no-cache, проставляйте build id там, где заголовки задать нельзя, и позвольте самоочищающемуся service worker убрать кеши версий до 3.41."
pubDate: 2026-09-11
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "deployment"
  - "caching"
  - "how-to"
lang: "ru"
translationOf: "2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload"
translatedBy: "claude"
translationDate: 2026-09-11
---

**Короткий ответ:** Flutter web генерирует точки входа с фиксированными именами файлов (`flutter_bootstrap.js`, `main.dart.js`, `main.dart.wasm`, `canvaskit/...`), а обычная перезагрузка в браузере перепроверяет только HTML-документ. Если хостинг отдаёт для этих файлов хоть какой-то срок свежести (Firebase Hosting отдаёт `max-age=3600`, GitHub Pages отдаёт `max-age=600`), перезагруженная страница получает свежий `index.html` и старый `main.dart.js` из кеша. Исправляется это так: вся папка `build/web` отдаётся с `Cache-Control: no-cache`, а на хостингах, где заголовки задать нельзя, после `flutter build web` к `flutter_bootstrap.js` и `main.dart.js` добавляется build id. Если у пользователей всё ещё стоит offline-first service worker из Flutter 3.38 или более ранней версии, продолжайте разворачивать стандартный `flutter_service_worker.js`: начиная с Flutter 3.41 это самоочищающийся worker, который снимает регистрацию старого и перезагружает вкладку.

Всё описанное ниже воспроизведено на Flutter 3.44.8 (Dart 3.12.2) и сверено с исходным кодом инструмента и движка версии 3.47.3, которые ведут себя в этой проблеме так же. Тесты в браузере проводились в браузере на базе Chromium с небольшим сервером на Node, умеющим переключать политику `Cache-Control`.

## Два разных кеша, в зависимости от того, когда вы впервые выпустили приложение

Результаты поиска по этой проблеме смешивают две эпохи, и исправление для них разное:

- **Flutter 3.38.x и более ранние версии** генерировали offline-first service worker. Он отдавал каждый файл из своей карты `RESOURCES` прямо из Cache Storage, только `index.html` запрашивал сначала из сети и требовал второй загрузки, прежде чем новое развёртывание вступало в силу. Отсюда и классический совет "надо перезагрузить дважды".
- **Flutter 3.41.0 и более поздние версии** больше не устанавливают кеширующий service worker для новых посетителей. [PR #176834](https://github.com/flutter/flutter/pull/176834) (слит в октябре 2025 года, впервые в стабильной версии 3.41.0) заменил worker размером 6 KB на очищающий worker размером 784 байта, а загрузчик в `flutter.js` регистрирует его, только если у origin уже есть регистрация. В новом приложении на 3.41+ в игре остаётся только обычный HTTP-кеш, и именно о нём в основном эта статья.

Понять, в каком из миров вы находитесь, можно в DevTools, Application, Service workers. Если регистрации нет, виноват HTTP-кеш.

## Почему перезагрузка не загружает новый main.dart.js

Посмотрите, что `flutter build web` кладёт в `build/web` на 3.44.8:

```text
# flutter build web, Flutter 3.44.8
index.html
flutter_bootstrap.js
flutter.js
flutter_service_worker.js
main.dart.js
version.json
manifest.json
assets/AssetManifest.bin
assets/FontManifest.json
assets/fonts/MaterialIcons-Regular.otf
canvaskit/canvaskit.js
canvaskit/canvaskit.wasm
```

Ни одно из этих имён не содержит хеша содержимого. `index.html` загружает `flutter_bootstrap.js`, в котором находится `_flutter.buildConfig`, чей `mainJsPath` равен литеральной строке `"main.dart.js"`. Каждое развёртывание использует те же URL, поэтому только по URL браузер не может отличить новую сборку от старой.

Теперь добавьте к этому то, как работает перезагрузка. Перезагрузка в Chrome перепроверяет основной ресурс, а затем выполняет обычную загрузку страницы. В статье команды Chromium 2017 года сказано, что браузер решил "only validate the main resource and continue with a regular page load" ([блог Chromium](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html)). Подресурсы, которые по своему `Cache-Control` ещё свежие, берутся прямо из дискового кеша без запроса. При обычной навигации (закладка, введённый URL, ссылка) любой браузер переиспользует свежие копии, включая сам `index.html`.

Поэтому покажет ли перезагрузка новую сборку, целиком зависит от того, что хостинг отдаёт для этих файлов:

| Хостинг | `Cache-Control` по умолчанию для статических файлов | Окно устаревания после развёртывания |
| --- | --- | --- |
| Firebase Hosting | `max-age=3600` (наблюдалось на `*.firebaseapp.com`) | до 1 часа |
| GitHub Pages | `max-age=600`, не настраивается | до 10 минут |
| Netlify, Vercel, Cloudflare Pages | `public, max-age=0, must-revalidate` | нет |
| Nginx, Apache, `python -m http.server` без настройки | заголовка нет, но отдаётся `Last-Modified` | эвристика, см. ниже |

На последней строке люди и попадаются. Отсутствие заголовка `Cache-Control` не означает "не кешировать". При наличии заголовка `Last-Modified` [RFC 9111, раздел 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2) позволяет браузеру выбрать эвристический срок свежести, обычно 10% времени с момента последнего изменения файла. `main.dart.js`, который последний раз разворачивали десять дней назад, может считаться свежим целые сутки.

Firebase действительно очищает свой CDN при каждом развёртывании, так что edge сразу отдаёт новые файлы. Собственный кеш браузера не очищается, а перезагрузка использует именно эту копию.

## Минимальное воспроизведение

Этот сервер отдаёт `build/web` с переключаемой политикой. `firebase` имитирует настройки Firebase Hosting по умолчанию, `fixed` означает исправление:

```js
// server.mjs, Node 22. Usage: MODE=firebase node server.mjs build/web
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'ETag': `"${stat.size}-${stat.mtimeMs}"`,
    'Cache-Control': process.env.MODE === 'fixed' ? 'no-cache' : 'max-age=3600',
  };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
  console.log(200, p);
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(8765);
```

И приложение, единственная задача которого показать, какая сборка запущена:

```dart
// lib/main.dart, Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

const build = 'A';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('Build $build')))),
);
```

Шаги: соберите с `build = 'A'`, запустите сервер с `MODE=firebase`, откройте `http://localhost:8765/`. Поменяйте константу на `'B'`, снова выполните `flutter build web` и перезагрузите вкладку. На странице по-прежнему написано "Build A". В журнале сервера для этой перезагрузки ровно один запрос:

```text
200 /index.html
```

`flutter_bootstrap.js`, `main.dart.js`, CanvasKit и шрифты были взяты из кеша браузера. Повторите всю последовательность с `MODE=fixed` на новом origin, и перезагрузка покажет "Build B". Повторная перезагрузка без нового развёртывания после этого стоит одного условного запроса на файл, и на каждый приходит `304` без тела.

## Исправление по шагам

1. **Отдавайте результат сборки Flutter с `Cache-Control: no-cache`.** `no-cache` не отключает кеширование. Он говорит браузеру хранить файл, но перед каждым использованием перепроверять его через `If-None-Match` или `If-Modified-Since`. Неизменённые файлы стоят одного сетевого обмена и `304`. Изменённые файлы загружаются заново. Применяйте это к `index.html`, `flutter_bootstrap.js`, `flutter.js`, `flutter_service_worker.js`, `main.dart.js`, `main.dart.mjs`, `main.dart.wasm`, `version.json`, `manifest.json`, ко всему внутри `assets/` и к локальной папке `canvaskit/`. Самое простое корректное правило: "всё в `build/web`".
2. **Пропишите правило в конфигурации хостинга.** Ниже есть примеры для Firebase Hosting, Nginx и файла `_headers`, который используют Netlify и Cloudflare Pages.
3. **Переждите один старый срок жизни.** Новые заголовки применяются только к ответам, полученным после изменения. Браузеры, закешировавшие `main.dart.js` с `max-age=3600`, будут использовать его, пока этот час не истечёт. Выкатывайте изменение заголовков на одно развёртывание раньше, чем оно понадобится, или при первом выкатывании совместите его с build id (шаг 4).
4. **Там, где заголовки задать нельзя, проставляйте build id.** Типичный случай: GitHub Pages. Переписывайте URL точек входа после каждой сборки, чтобы у каждого развёртывания были новые URL.
5. **Сообщайте уже открытым вкладкам.** Заголовки помогают только при следующей загрузке. Долгоживущая вкладка продолжает выполнять старую сборку, пока пользователь её не перезагрузит, поэтому периодически опрашивайте небольшой файл с build id и предлагайте перезагрузку.

### Firebase Hosting

[FAQ по Flutter web](https://docs.flutter.dev/platform-integration/web/faq) предлагает `max-age=0,s-maxage=604800` для `js`, `mjs`, `wasm` и `json`, что держит CDN прогретым и при этом заставляет браузер перепроверять файлы. Этот шаблон не охватывает HTML и `.bin`, а изображениям и шрифтам даёт `max-age=3600`, поэтому `index.html`, `assets/AssetManifest.bin` и любое изображение, заменённое под тем же именем, остаются устаревшими в течение часа. Этот `firebase.json` покрывает всю сборку:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cache-Control", "value": "no-cache" }
        ]
      }
    ]
  }
}
```

Поскольку Firebase очищает свой CDN при развёртывании, `s-maxage` для корректной работы edge не нужен. Возвращайте его, только если измерения покажут проблему с задержкой.

### Nginx

```nginx
# nginx 1.27, serving the output of flutter build web
server {
    listen 80;
    root /var/www/app/build/web;

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        etag on;
    }
}
```

Оставьте `etag on` (значение по умолчанию). Без валидатора браузеру нечем перепроверять файл, и он каждый раз загружает его целиком.

### Netlify и Cloudflare Pages

Оба по умолчанию уже используют `max-age=0, must-revalidate`, и это работает корректно. Если прежняя конфигурация или пресет фреймворка добавили более длинный срок жизни, переопределите его файлом `_headers` в `web/`, чтобы `flutter build web` скопировал его в `build/web`:

```text
# web/_headers, copied to build/web by flutter build web (Flutter 3.44)
/*
  Cache-Control: no-cache
```

### GitHub Pages и другие хостинги без заголовков

Запускайте небольшой скрипт после сборки. Он добавляет `?v=<id>` к тегу скрипта bootstrap и к путям сборки внутри `_flutter.buildConfig`, а также записывает id в `build_id.txt` для шага 5:

```bash
#!/usr/bin/env bash
# bust.sh, run after `flutter build web` (Flutter 3.44 output layout)
set -euo pipefail
ID="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
OUT=build/web
sed -i.bak "s|src=\"flutter_bootstrap.js\"|src=\"flutter_bootstrap.js?v=$ID\"|" "$OUT/index.html"
sed -i.bak -E "s#\"(main\.dart\.(js|wasm|mjs))\"#\"\1?v=$ID\"#g" "$OUT/flutter_bootstrap.js"
rm "$OUT"/*.bak
echo "$ID" > "$OUT/build_id.txt"
```

При политике `max-age=600` перезагрузка после развёртывания помеченной сборки запросила ровно три файла (`index.html`, `flutter_bootstrap.js?v=...`, `main.dart.js?v=...`) и показала новую сборку, а CanvasKit и шрифты по-прежнему брались из кеша. Именно этот подход описан в FAQ по Flutter, где отмечено, что Flutter не добавляет build id автоматически. Сам `index.html` при обычной навигации всё ещё подчиняется 10-минутному сроку жизни (перезагрузка всегда его перепроверяет), а ресурсы, заменённые под тем же именем, этим не покрываются, поэтому изменённые изображения переименовывайте, а не перезаписывайте.

### Предложите перезагрузку открытым вкладкам

Передайте тот же id приложению во время компиляции и сравнивайте его с развёрнутым `build_id.txt`. `cache: 'no-store'` не пускает саму проверку в HTTP-кеш:

```dart
// lib/update_check.dart, Flutter 3.44.8, Dart 3.12.2, package:web 1.1.1
import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// flutter build web --dart-define=BUILD_ID=$(git rev-parse --short HEAD)
const buildId = String.fromEnvironment('BUILD_ID', defaultValue: 'dev');

Future<bool> newBuildAvailable() async {
  try {
    final response = await web.window
        .fetch('build_id.txt'.toJS, web.RequestInit(cache: 'no-store'))
        .toDart;
    if (!response.ok) return false;
    final deployed = (await response.text().toDart).toDart.trim();
    return deployed.isNotEmpty && deployed != buildId;
  } catch (_) {
    return false; // offline or blocked: keep running the current build
  }
}

void startUpdateCheck(GlobalKey<ScaffoldMessengerState> messenger) {
  if (buildId == 'dev') return;
  Timer.periodic(const Duration(minutes: 5), (timer) async {
    if (!await newBuildAvailable()) return;
    timer.cancel();
    messenger.currentState?.showSnackBar(
      SnackBar(
        duration: const Duration(days: 1),
        content: const Text('A new version is available.'),
        action: SnackBarAction(
          label: 'Reload',
          onPressed: () => web.window.location.reload(),
        ),
      ),
    );
  });
}
```

Задайте `MaterialApp` свойство `scaffoldMessengerKey` и вызовите с ним `startUpdateCheck` из `main`. При сборке с `--dart-define=BUILD_ID=A` и развёрнутом `build_id.txt`, содержащем `B`, `newBuildAvailable()` вернул `true` при первой же проверке. Если вы не используете `bust.sh`, записывайте `build_id.txt` в CI с тем же id. Особенно это важно, когда API бэкенда меняется вместе с фронтендом, потому что старая вкладка, вызывающая новый API, это худшая ошибка, чем старый интерфейс.

## Если вы выпускали service worker до Flutter 3.41

У пользователей, впервые открывших приложение, когда оно собиралось на 3.38.x или более ранней версии, в браузере всё ещё есть offline-first worker и его `flutter-app-cache`. Вот что происходит, когда они впервые загружают развёртывание, собранное на 3.41 или более поздней версии, согласно исходному коду 3.44.8 и 3.47.3:

1. Старый worker всё ещё управляет страницей, поэтому на навигацию он отвечает сначала из сети (новый `index.html`), но `flutter_bootstrap.js` и `main.dart.js` отдаёт из Cache Storage. Пользователь может ненадолго увидеть старую сборку.
2. Проверка обновления service worker в браузере загружает `flutter_service_worker.js` из сети. Файл отличается побайтно (теперь это очищающий worker размером 784 байта), поэтому он устанавливается.
3. Очищающий worker вызывает `skipWaiting()`, затем в `activate` вызывает `self.registration.unregister()` и переводит каждое управляемое им окно на его текущий URL.
4. Эта навигация происходит без service worker, поэтому страница загружает текущую сборку через HTTP-кеш. С заголовками из предыдущего раздела это новая сборка.

Очищающий worker не удаляет `flutter-app-cache`, `flutter-temp-cache` и `flutter-app-manifest`. Без worker их никто не читает, но место в хранилище они продолжают занимать. Если это для вас важно, удалите их один раз при запуске через Cache Storage API (`caches.delete('flutter-app-cache')` и так далее, через `package:web`).

Эту передачу управления блокируют две ошибки при развёртывании:

- **Удаление `flutter_service_worker.js` из развёртывания.** Если проверка обновления получает `404`, браузер сохраняет существующий worker, и старый worker продолжает отдавать старый `main.dart.js` из Cache Storage. Продолжайте выкладывать этот файл, пока у вас могут оставаться посетители со старой версией.
- **Слишком ранняя сборка с `--pwa-strategy=none`.** В 3.44 этот флаг скрыт и объявлен устаревшим, а при использовании выводит ссылку на [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910). С `none` инструмент записывает пустой `flutter_service_worker.js` и убирает `serviceWorkerSettings` из `flutter_bootstrap.js`, так что снять регистрацию старого worker некому. Браузер в итоге устанавливает пустой скрипт, но тот вступает в силу только после закрытия всех вкладок приложения, а регистрация так и не исчезает. Путь очистки есть только в сборке по умолчанию.

Если вам нужна настоящая офлайн-поддержка, [FAQ по Flutter](https://docs.flutter.dev/platform-integration/web/faq) теперь советует использовать собственный worker, например на Workbox. Дайте ему версионированное имя кеша и стратегию network-first для `index.html` и `flutter_bootstrap.js`, иначе вы воссоздадите старую проблему.

## Подводные камни и похожие проблемы

- **Жёсткая перезагрузка скрывает ошибку.** Ctrl+Shift+R (Cmd+Shift+R на macOS) обходит HTTP-кеш и service worker для этой загрузки, поэтому сами разработчики эту проблему видят редко. Проверяйте обычной перезагрузкой или с выключенным "Disable cache" в DevTools.
- **CanvasKit с CDN безопасен, локальный CanvasKit нет.** По умолчанию загрузчик берёт CanvasKit с `gstatic.com` по URL, содержащему ревизию движка, поэтому обновление Flutter меняет URL. С `--no-web-resources-cdn` CanvasKit отдаётся из `canvaskit/` под одним и тем же именем в каждом релизе. Агрессивный срок жизни там может после обновления Flutter свести новый `main.dart.js` со старым CanvasKit.
- **Длинные сроки жизни у "статических" ресурсов.** Некоторые хостинги и пресеты CDN дают файлам `.js` значения `max-age` в 30 дней, предполагая хешированные имена. Для результата сборки Flutter это предположение неверно. Проверяйте фактические заголовки ответа с помощью `curl -I https://your.app/main.dart.js`.
- **У сборок Wasm больше точек входа.** Сборка с `--wasm` также загружает `main.dart.mjs` и `main.dart.wasm`, а для браузеров вне своего списка разрешённых загрузчик откатывается на `main.dart.js`. Всем трём нужна одинаковая обработка, поэтому `bust.sh` переписывает их все.
- **Устаревшее поведение, которое не связано с кешем.** Если новая сборка загружается, но маршруты при обновлении страницы отдают 404, значит, не хватает SPA-переписывания (`try_files ... /index.html` или `"rewrites"` в `firebase.json`). Если ресурсы отдают 404 только под подпутём, проверьте `--base-href`.

## Связанные материалы

- [Как собрать веб-приложение на Flutter с WebAssembly](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/): о дополнительных точках входа Wasm и заголовках COOP/COEP, которые находятся рядом с `Cache-Control` в той же конфигурации хостинга.
- [Миграция веб-приложения на Flutter с `dart:html` на `package:web`](/ru/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/): о стиле interop, использованном в проверке обновлений.
- [Исправление: Text во Flutter рисуется за пределами экрана в Android WebView](/ru/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/): ещё одна проблема Flutter web, которая проявляется только после развёртывания.
- [Output caching и response caching в ASP.NET Core 11](/ru/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/): если вашу сборку Flutter web отдаёт бэкенд на ASP.NET Core и заголовки `Cache-Control` вы задаёте там.

## Источники

- [FAQ по Flutter web](https://docs.flutter.dev/platform-integration/web/faq): удаление service worker, рекомендации по `Cache-Control` и техника build id.
- [Инициализация веб-приложения Flutter](https://docs.flutter.dev/platform-integration/web/initialization): токены шаблона `flutter_bootstrap.js`.
- [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910): объявление устаревшим и удаление `flutter_service_worker.js`.
- [flutter/flutter PR #176834](https://github.com/flutter/flutter/pull/176834): самоочищающийся service worker, впервые выпущенный в 3.41.0.
- [`service_worker_loader.js` в 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/flutter_js/src/service_worker_loader.js) и [`flutter_service_worker.js` в 3.38.10](https://github.com/flutter/flutter/blob/3.38.10/packages/flutter_tools/lib/src/web/file_generators/js/flutter_service_worker.js): поведение старого и нового worker.
- [Блог Chromium: Reload, reloaded](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html): перезагрузка перепроверяет только основной ресурс.
- [RFC 9111, раздел 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2): эвристическая свежесть, когда явный срок жизни не передаётся.
- [Поведение кеша в Firebase Hosting](https://firebase.google.com/docs/hosting/manage-cache): очистка CDN при повторном развёртывании.

---
title: "Миграция веб-приложения на Flutter с dart:html на package:web и dart:js_interop"
description: "Пошаговая миграция с устаревших dart:html, dart:js_util и package:js на package:web 1.1.1 и dart:js_interop: как найти каждый проблемный импорт с помощью компилятора dart2wasm, что переименовывает dart fix, а что нет, ловушки JSImmutableListWrapper и innerHTML, и как проверить результат через flutter build web --wasm."
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
lang: "ru"
translationOf: "2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web"
translatedBy: "claude"
translationDate: 2026-09-03
---

Веб-код на Flutter в рамках одного приложения с горсткой вызовов `dart:html` мигрируется за полдня. Код, в котором `dart:html` просочился в общие пакеты, в моки или в плагин, который вы сами поддерживаете, займёт неделю, и узким местом почти никогда не оказывается ваш собственный код: это транзитивная зависимость, которая всё ещё импортирует устаревшую библиотеку. Ничего из этого больше не является необязательным. `dart:html`, `dart:js`, `dart:js_util` и `package:js` были помечены устаревшими в Dart 3.7 (февраль 2025), ни один из них не компилируется под `dart2wasm`, а замена, [`package:web`](https://pub.dev/packages/web) 1.1.1 вместе с `dart:js_interop`, стабильна с июля 2024 года. Это руководство ориентировано на текущий канал stable, Flutter 3.47.2 с Dart 3.13.2 (выпущен 2026-08-27), и на `package:web` 1.1.1, который требует Dart `^3.4.0`. Каждый вывод компилятора ниже получен в реальном запуске на стабильном наборе инструментов Flutter 3.44.8 / Dart 3.12.2 с тем же `package:web` 1.1.1.

## Почему откладывать это больше нельзя

- **WebAssembly зависит от этого.** `dart2wasm` отказывается компилировать программу, которая транзитивно доходит до `dart:html`. Если вам нужен выигрыш, описанный в статье про [сборку веб-приложения на Flutter командой `flutter build web --wasm`](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), эта миграция является платой за вход, а не оптимизацией.
- **Устаревание уже влияет на сборку.** `dart analyze` сообщает `deprecated_member_use` прямо на строке импорта, поэтому любая задача CI с `--fatal-infos` уже падает или находится в одном изменении конфигурации от падения.
- **`package:web` версионируется отдельно от SDK.** Новые API браузера приходят как версия пакета, а не ждут релиза SDK, и `package:web` генерируется напрямую из Web IDL, поэтому имена совпадают с MDN, а не с руководством по стилю Dart образца 2013 года.
- **Если вы публикуете пакет, ваши пользователи не смогут компилировать в Wasm, пока вы не мигрируете.** Один импорт `dart:html` в конечном пакете блокирует весь граф зависимостей ниже по цепочке.

## Что ломается

| Область | Изменение | Серьёзность |
| ------- | --------- | ----------- |
| Имена типов | Имена в стиле Dart возвращаются к именам из IDL: `HtmlElement` становится `HTMLElement`, `InputElement` становится `HTMLInputElement`, `AnchorElement` становится `HTMLAnchorElement` | высокая, но почти всё автоматизируется |
| Коллекции | `querySelectorAll` и `children` возвращают `NodeList` / `HTMLCollection`, которые не реализуют `List` | высокая |
| Проверки типов | `is` и `as` больше не работают на типах браузера, потому что каждый тип `package:web` стирается до `JSObject` | высокая |
| Моки | У extension type нет виртуальной диспетчеризации, поэтому мок с `implements` от класса `dart:html` не может реализовать тип `package:web` | высокая |
| Сигнатуры типов | `innerHTML` имеет тип `JSAny`, слушатели событий принимают `JSFunction`, поэтому в местах вызова нужен `.toJS` | средняя |
| Зоны | Колбэки больше не привязываются к текущей зоне автоматически | средняя |
| Условные импорты | `dart.library.html` должен стать `dart.library.js_interop` | средняя |
| Платформенные представления | Фабрики представлений должны возвращать элемент `package:web` и регистрироваться через `dart:ui_web` | средняя |
| `dart:js_util` | `getProperty` / `setProperty` / `callMethod` переезжают в `dart:js_interop_unsafe` с ключами типа `JSAny` | низкая, механическая |

## Подготовительный список

- Flutter 3.47.2 или новее на канале stable. Подойдёт всё начиная с Flutter 3.22 (Dart 3.4), но описанные ниже исправления анализатора работают лучше в свежих SDK.
- `flutter pub add web`, который разрешается в `web: ^1.1.1`.
- Задача CI, которая запускает `flutter build web --wasm`, даже если вы пока не поставляете сборку Wasm. Это единственный надёжный детектор устаревших импортов, спрятанных в зависимостях.
- Отдельная ветка, а не серия мелких коммитов в `main`. Проход переименования затрагивает сразу много файлов, и по частям его тяжело ревьюить.
- Список пакетов, от которых вы зависите и которые последний раз публиковались до середины 2024 года. Это ваши вероятные блокеры.

## Шаги миграции

1. **Найдите каждый проблемный импорт компилятором, а не через grep.** `grep -r "dart:html" lib/` находит ваш код и пропускает зависимость тремя уровнями ниже, которая на самом деле вас блокирует. `dart2wasm` вместо этого печатает полную цепочку импортов. Запустите `flutter build web --wasm` и прочитайте первую ошибку:

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

   Блок "Detailed import paths" и есть самое полезное. Когда цепочка заканчивается на пакете из pub, а не на вашем собственном `lib/`, вы нашли зависимость, которую придётся обновить, форкнуть или заменить, прежде чем приложение сможет переехать.

   Проверка: каждый путь, напечатанный компилятором, записан и отнесён к категории "мой код", "мой пакет" или "сторонний". Ничего не остаётся с пометкой "наверное, нормально".

2. **Смените импорт и добавьте зависимость.** По файлам `import 'dart:html' as html;` превращается в `import 'package:web/web.dart' as web;`. Сохраните префикс. Импорт `package:web` без префикса вносит в область видимости несколько сотен имён верхнего уровня и конфликтует с собственными `Element`, `Image` и `Text` из Flutter.

   ```console
   flutter pub add web
   ```

   Проверка: `flutter pub deps | grep web` показывает `web 1.1.1`, а ошибки файла меняются с "deprecated" на список неопределённых имён. Неопределённые имена -- это прогресс, они делают работу по переименованию видимой.

3. **Запустите `dart fix` для переименования типов, остальное доделайте руками.** В `package:web` входит `lib/fix_data.yaml` со 141 преобразованием переименования, поэтому анализатор может переписать большинство устаревших имён типов, как только новый импорт на месте:

   ```console
   dart fix --dry-run
   dart fix --apply
   ```

   В файле, где есть `InputElement`, `HtmlElement` и `CheckboxInputElement`, `dart fix --apply` переписывает первые два и оставляет третий нетронутым:

   ```dart
   // After dart fix --apply, package:web 1.1.1
   final HTMLInputElement input = HTMLInputElement();
   final HTMLElement box = document.querySelector('#box') as HTMLElement;
   final CheckboxInputElement cb = CheckboxInputElement(); // still undefined
   ```

   `CheckboxInputElement` -- это не переименование, а удобный тип из `dart:html` без аналога в IDL. Ручная форма выглядит так: `HTMLInputElement()..type = 'checkbox'`. Если для имени нет преобразования, посмотрите аннотацию `@Native` у старого класса `dart:html`: её значение и есть имя в `package:web`.

   Проверка: `dart analyze` не выдаёт ни одной диагностики `undefined_class` и `undefined_function` в мигрированных файлах.

4. **Замените `dart:js_util` и `package:js` на `dart:js_interop`.** Старые динамические аксессоры переезжают в `dart:js_interop_unsafe` и принимают ключи `JSAny` вместо `String`. Объявленный interop переходит от классов с `@JS()` к extension type над `JSObject`. Было:

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

   Стало:

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

   Три шаблона, которые стоит запомнить: `allowInterop(fn)` превращается в `fn.toJS`, `js_util.promiseToFuture(p)` превращается в `p.toDart`, а `JSPromise<T>`, ожидаемый через `.toDart`, даёт `Future<T>`. У `HttpRequest` нет прямой замены, которую стоило бы использовать; ответ -- это `window.fetch` или `package:http`.

   Проверка: `dart analyze` чист, и ни один файл в репозитории больше не импортирует `dart:js`, `dart:js_util` или `package:js`.

5. **Перенесите фабрики платформенных представлений в `dart:ui_web`.** Любой код, регистрирующий HTML-представление, теперь обязан возвращать элемент `package:web`. Реестр живёт в `dart:ui_web`, а `registerViewFactory` объявлен как `registerViewFactory(String viewType, Function viewFactory, {bool isVisible = true})`:

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

   Проверка: представление отрисовывается в `flutter run -d chrome`, а `flutter build web --wasm` компилирует файл без нареканий.

6. **Перепишите условные импорты на `dart.library.js_interop`.** Старое написание под `dart2wasm` молча выбирает заглушку, потому что там `dart.library.html` ложно, и это даёт `UnsupportedError` во время выполнения вместо ошибки компиляции. Это худший режим отказа во всей миграции:

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

   Проверка: сделайте grep по репозиторию на `dart.library.html` и убедитесь, что совпадений нет, затем запустите приложение на нативной платформе и в вебе, чтобы убедиться, что каждая ветка по-прежнему разрешается. Тот же приём применим и к более широкой задаче [платформенно-зависимого кода без плагина](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

7. **Тесты чините в последнюю очередь, потому что моки ломаются иначе.** Типы `package:web` -- это extension type над `JSObject`, поэтому подделка с `implements HTMLElement` не скомпилируется. Замените фейки на основе классов настоящими узлами DOM, создаваемыми в тесте, или объектом JS, который вы собираете и передаёте тестируемому коду. Всё, что использовало `dynamic` для вызова члена DOM, тоже перестаёт работать, потому что члены extension type разрешаются только статически.

   Проверка: `flutter test` проходит, и в наборе тестов не осталось ни одной конструкции `implements`, указывающей на тип `package:web`.

## Проверка

Запустите все четыре команды в этом порядке:

```console
dart analyze --fatal-infos
flutter test
flutter build web
flutter build web --wasm
```

Последняя команда и есть настоящий барьер. В мигрированном приложении она заканчивается строкой `Built build/web` и кладёт `main.dart.wasm`, `main.dart.mjs` и запасной вариант от `dart2js` `main.dart.js` в `build/web`. Если она всё ещё падает, ошибка называет точную оставшуюся цепочку импортов. После этого загрузите приложение и прокликайте всё, что затрагивает DOM: скачивание файлов, буфер обмена, iframe, `localStorage` и любой JS SDK, с которым вы общаетесь через interop.

## План отката

Откат по одному файлу делается легко, а откат всего репозитория планировать не стоит. `package:web` и `dart:html` могут сосуществовать в одной программе, так что вы можете мигрировать один файл, выкатить его и откатить именно этот файл, если что-то сломается. Чего сделать нельзя, так это откатиться после того, как вы удалили ветки кода на `dart:html` и выкатили сборку Wasm, потому что сборка Wasm их никогда и не поддерживала. Держите сборку `dart2js` как продакшен-цель, пока не завершите описанный выше ручной прогон; `flutter build web --wasm` выпускает обе, а загрузчик сам переключается на запасную.

## Ловушки, о которых стоит знать заранее

**Официальный пример с `JSImmutableListWrapper` не компилируется.** `JSImmutableListWrapper<T, U>` не может вывести `U` из аргумента конструктора, поэтому откатывается к границе параметра, `JSObject`:

```dart
for (final a in JSImmutableListWrapper(document.querySelectorAll('a'))) {
  a.classList.add('link'); // error: The getter 'classList' isn't defined for the type 'JSObject'
}
```

Передавайте оба аргумента типа явно:

```dart
// package:web 1.1.1
for (final a in JSImmutableListWrapper<NodeList, Element>(
  document.querySelectorAll('a'),
)) {
  a.classList.add('link');
}
```

**`innerHTML` имеет тип `JSAny` в обе стороны.** Для записи нужен `.toJS`, для чтения нужен каст: `final String s = el.innerHTML;` падает с сообщением "A value of type 'JSAny' can't be assigned to a variable of type 'String'". Читайте как `(el.innerHTML as JSString).toDart`. То же самое относится к `outerHTML` и к `insertAdjacentHTML`, у которого второй параметр имеет тип `JSAny`.

**`element.text` -- это сеттер без геттера.** `package:web` сохраняет устаревший сеттер `text` для удобства миграции, но чтение требует `textContent`, который имеет тип `String?`, а не `String`. Коду, который делал `if (el.text.isEmpty)`, теперь нужна проверка на null.

**Колбэки теряют зону.** `dart:html` привязывал колбэки событий к текущей зоне автоматически, `package:web` этого не делает. Если вы полагаетесь на локальные значения зоны или на то, что обработчик ошибок на основе зон поймает происходящее внутри слушателя, привязывайте вручную перед конвертацией:

```dart
element.addEventListener(
  'click',
  Zone.current.bindUnaryCallback((Event event) {
    // zone-local values are preserved here
  }).toJS,
);
```

**Проверки типов молча меняют смысл.** `obj is Window` прекрасно компилировался под `dart:html`; под `package:web` каждый тип стирается до `JSObject`, так что проверка бессмысленна. Используйте `element.isA<HTMLInputElement>()` (Dart 3.4 и новее) или `obj.instanceOfString('Window')`.

**Некоторые привычки из `dart:html` выживают в виде устаревших заглушек.** `window.localStorage['k'] = 'v'` по-прежнему проходит анализ, но с сообщением "'[]=' is deprecated and shouldn't be used. Use Storage.setItem instead", а `querySelector` верхнего уровня существует с сообщением "Directly use document.querySelector instead". Сегодня они компилируются, но конечной точкой не являются. Переводите их в том же проходе, иначе сделаете эту работу дважды.

**Потоки событий никуда не делись и остаются самым удобным путём.** В `package:web` есть вспомогательные потоки, поэтому `input.onClick.listen(...)` работает без изменений и возвращает `ElementStream<MouseEvent>`. Предпочитайте их сырому `addEventListener` вместе с `.toJS` везде, где подписку нужно отменять. Учтите, что вспомогательные потоки доставляют часть событий асинхронно там, где `dart:html` был синхронным, поэтому код, чувствительный к таймингу, требует второго взгляда.

## Похожие материалы

- Ради чего делается вся эта работа, подробно описано в статье [сборка веб-приложения на Flutter с WebAssembly](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), включая причину, по которой Firefox и Safari по-прежнему получают сборку на JavaScript.
- Структурно это такой же широкий механический проход, как и [миграция приложения с Flutter 2 на Flutter 3.x](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/): план в два прыжка и компилятор, который сообщает, когда вы закончили.
- Механизм условных импортов из шага 6 лежит в основе [платформенно-зависимого кода без плагина](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).
- Если вы одновременно обновляете Flutter, прочитайте, [что Flutter 3.47 изменил в отрисовке на десктопе](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), прежде чем винить эту миграцию в визуальной регрессии.
- Веб также является той платформой, где [изоляты Dart](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) ведут себя иначе, чем везде, и это полезно знать, прежде чем переносить нагруженную процессором работу в том же проходе.

## Источники

- [Migrate to package:web](https://dart.dev/interop/js-interop/package-web), dart.dev
- [Past JS interop](https://dart.dev/interop/js-interop/past-js-interop), dart.dev
- [JS types and conversions](https://dart.dev/interop/js-interop/js-types), dart.dev
- [Breaking changes and deprecations](https://dart.dev/resources/breaking-changes), dart.dev
- [package:web на pub.dev](https://pub.dev/packages/web), версия 1.1.1
- [Справочник API EventStreamProviders](https://pub.dev/documentation/web/latest/web/EventStreamProviders-class.html), package:web
- [dart:ui_web PlatformViewRegistry](https://api.flutter.dev/flutter/dart-ui_web/PlatformViewRegistry-class.html), документация API Flutter
- [Announcing Dart 3.13](https://dart.dev/blog/announcing-dart-3-13), блог Dart

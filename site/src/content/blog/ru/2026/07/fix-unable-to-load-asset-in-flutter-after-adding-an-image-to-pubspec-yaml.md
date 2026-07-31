---
title: "Исправление: Unable to load asset во Flutter после добавления изображения в pubspec.yaml"
description: "Ключа ассета нет в собранном bundle, а не на диске. Исправьте отступы в pubspec, добавьте слэш, приведите ключ в точное соответствие и перезапустите приложение."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pubspec"
  - "assets"
lang: "ru"
translationOf: "2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-07-31
---

Файл лежит на диске, путь выглядит правильным, а Flutter всё равно говорит, что не может его загрузить. Дело в том, что сообщение не про диск: переданного вами ключа нет в собранном bundle ассетов. По убыванию частоты причина такая: блок `assets:` не имеет отступа под `flutter:`, у записи каталога отсутствует завершающий `/`, файл лежит в подкаталоге, который никогда не объявляли, ключ отличается от имени файла регистром, либо был сделан hot reload там, где нужен полный перезапуск. Исправьте `pubspec.yaml`, остановите приложение и запустите его заново.

```text
======== Exception caught by image resource service ================================================
The following assertion was thrown resolving an image codec:
Unable to load asset: "assets/images/logo.png".
The asset does not exist or has empty data.

When the exception was thrown, this was the stack:
#0      PlatformAssetBundle.load (package:flutter/src/services/asset_bundle.dart:271:7)
<asynchronous suspension>
#1      AssetBundleImageProvider._loadAsync (package:flutter/src/painting/image_provider.dart:951:14)
```

Это руководство написано для Flutter 3.44.7 и Dart 3.12.2, канал stable по состоянию на 2026-07-20. Описанное поведение стабильно с тех пор, как Flutter 3.16 изменил формат манифеста ассетов, а правила pubspec не менялись годами.

## Что на самом деле означает ошибка

`Image.asset('assets/images/logo.png')` не открывает файл. Этот вызов передаёт строковый ключ фреймворку, который запрашивает у движка байты, зарегистрированные под этим ключом в bundle ассетов приложения. `PlatformAssetBundle.load` выбрасывает исключение в тот момент, когда движок возвращает null или буфер нулевой длины:

```dart
// flutter/lib/src/services/asset_bundle.dart, Flutter 3.44.7
throw FlutterError.fromParts(<DiagnosticsNode>[
  _errorSummaryWithKey(key),
  ErrorDescription('The asset does not exist or has empty data.'),
]);
```

Этот bundle один раз собирает инструмент `flutter` из секции `flutter: assets:` файла `pubspec.yaml`. Всё перечисленное там копируется в `build/flutter_assets/` и индексируется в манифесте `AssetManifest.bin`, который движок загружает при старте. Больше ничего в вашей файловой системе для запущенного приложения не существует.

Значит, должны совпасть две независимые вещи, и ошибка не может подсказать, какая из них неверна:

1. Объявление в pubspec должно поместить файл в bundle.
2. Ключ в коде на Dart должен совпадать с ключом bundle побайтово.

Каждая причина ниже - это отказ одной из этих двух вещей.

## Минимальный пример воспроизведения

```
my_app/
  pubspec.yaml
  assets/
    images/
      logo.png
  lib/
    main.dart
```

```yaml
# pubspec.yaml, Flutter 3.44.7
name: my_app

flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

```dart
// lib/main.dart, Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Image.asset('assets/images/logo.png')),
        ),
      ),
    );
```

Это работает. Сломайте здесь любую строку одним из перечисленных ниже способов - и вы получите ту самую ошибку без какой-либо другой диагностики.

## Причина 1: блок assets не вложен в flutter

Это самый частый и самый неприятный сбой, потому что никто не жалуется. `flutter pub get` отрабатывает успешно, сборка проходит, а приложение стартует с пустым bundle.

```yaml
# Wrong. Valid YAML, silently ignored.
flutter:
  uses-material-design: true
assets:
  - assets/images/logo.png
```

`assets:` на верхнем уровне - это ключ, который инструмент Flutter не читает. Это не ошибка, для парсера это просто чужая конфигурация. Правильная форма даёт `assets:` ровно два пробела отступа под `flutter:`, а элементам списка - ещё два:

```yaml
# Right.
flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

Родственный случай: второй ключ `flutter:` ниже по файлу. В отображениях YAML не может быть дублирующихся ключей, и в зависимости от парсера один из них молча побеждает. Если ваш pubspec разрастался стихийно, найдите в нём все вхождения `flutter:` в нулевой колонке, прежде чем отлаживать что-либо ещё.

## Причина 2: запись каталога без завершающего слэша или подкаталог, который не объявляли

Записи каталогов подключаются по одной и не работают рекурсивно. Из документации Flutter про добавление ассетов: "Only files located directly in the directory are included. Resolution-aware asset image variants are the only exception. To add files located in subdirectories, create an entry per directory."

То есть вот это не объявляет ничего полезного, если ваши изображения лежат в `assets/images/icons/`:

```yaml
flutter:
  assets:
    - assets/images/
```

а нужно вот это:

```yaml
flutter:
  assets:
    - assets/images/
    - assets/images/icons/
    - assets/images/illustrations/
```

Именно завершающий слэш делает запись каталогом. `- assets/images` без него читается как единственный файл с именем `images`, и, поскольку такого файла нет, сборка падает на уровне инструмента с сообщением, которое действительно помогает:

```text
Error: unable to find directory entry in pubspec.yaml: /path/to/my_app/assets/images/
```

Это полезно знать и в обратную сторону: если сборка прошла успешно, а во время выполнения вы всё равно получаете `Unable to load asset`, значит, запись чему-то соответствовала. Тогда проблема в несовпадении ключа, а не в отсутствующем объявлении.

Единственное исключение из правила нерекурсивности - варианты под разное разрешение. Если вы объявили `assets/images/logo.png`, то `assets/images/2.0x/logo.png` и `assets/images/3.0x/logo.png` попадут в bundle автоматически, а `AssetImage` выберет нужный по device pixel ratio. Каталоги вариантов вы никогда не объявляете сами.

## Причина 3: ключ в коде не совпадает с ключом в bundle

Ключи bundle - это точные строки. Три способа разойтись с тем, что вы написали:

**Регистр.** На вашей машине для разработки почти наверняка файловая система нечувствительна к регистру (APFS в macOS по умолчанию, NTFS в Windows). `Image.asset('assets/images/Logo.png')` локально находит файл `logo.png` и падает на устройстве Android, в iOS, в web и на любом Linux-раннере CI. Если сборка работает на ноутбуке и падает везде остальном, проверяйте регистр первым делом. Это самое вероятное объяснение ситуации, когда один и тот же код ведёт себя по-разному на разных машинах.

**Ведущий `./` или случайный пробел.** `'./assets/images/logo.png'` - это другая строка, нежели `'assets/images/logo.png'`, а в bundle есть только вторая. Пробел в конце значения YAML в кавычках даёт тот же эффект.

**Префикс `packages/`.** Ассет, поставляемый внутри пакета, от которого вы зависите, имеет ключ `packages/<package_name>/<path>`, причём каталог `lib/` пакета подразумевается и никогда не пишется явно. Чтобы загрузить `lib/assets/bg.png` из пакета `fancy_backgrounds`:

```dart
// Flutter 3.44.7. Either form works; they produce the same key.
Image.asset('packages/fancy_backgrounds/assets/bg.png');
Image.asset('assets/bg.png', package: 'fancy_backgrounds');
```

Если пакет писали вы, он тоже должен объявить эти файлы в собственном `pubspec.yaml`. Ассеты зависимости не попадают в bundle только потому, что файл существует в `.pub-cache`.

## Причина 4: вы сделали hot reload там, где нужен перезапуск

Hot reload подменяет код на Dart в работающем изоляте. Bundle ассетов и его манифест создаёт инструмент при запуске приложения. Правка `pubspec.yaml` с добавлением новой записи меняет манифест, а работающее приложение сохраняет тот манифест, с которым стартовало.

Остановите сессию и запустите её заново. Ни `r`, ни `R`:

```bash
# Flutter 3.44.7
# Ctrl-C to end the current run, then:
flutter run
```

Изменение *байтов* уже объявленного ассета пересобирается при reload и в этом не нуждается. Изменение *набора* объявленных ассетов - нуждается.

## Причина 5: устаревшие артефакты на диске

Редко бывает причиной, дёшево исключается и стоит первым пунктом в каждом ответе в интернете, из-за чего на неё списывают куда больше сбоев, чем она вызывает. Реальной причиной она бывает на iOS, где наполовину обновлённый bundle `.app` может пережить пересборку:

```bash
# Flutter 3.44.7
flutter clean
flutter pub get
flutter run
```

Если по пути падает сам `flutter pub get`, это проблема разрешения зависимостей, а не ассетов, и вывод решателя ограничений - отдельное упражнение: см. [как читать ошибку version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Хватит гадать: выведите ключи, которые реально лежат в bundle

Каждый раздел выше - это гипотеза. Все их можно заменить одним измерением. `AssetManifest` - это поддерживаемый API для чтения манифеста во время выполнения, добавленный тогда, когда `AssetManifest.json` заменили на `AssetManifest.bin`:

```dart
// Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/services.dart';

Future<void> dumpAssetKeys() async {
  final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
  for (final key in manifest.listAssets()..sort()) {
    debugPrint(key);
  }
}
```

Вызовите это из `main` под проверкой `kDebugMode` и прочитайте консоль. Всё, что напечатано, движок способен отдать. Если вашего пути там нет, проблема в Причине 1 или 2. Если присутствует что-то почти совпадающее с вашим путём, это Причина 3, и разница между двумя строками и есть исправление.

Не разбирайте `AssetManifest.bin` самостоятельно. Flutter документирует его как деталь реализации, формат которой может измениться без объявления, а `AssetManifest.json` больше вообще не генерируется, поэтому код, который до сих пор вызывает `rootBundle.loadString('AssetManifest.json')`, выбрасывает ровно эту ошибку с ключом `AssetManifest.json`.

Bundle можно осмотреть и вовсе ничего не запуская:

```bash
# Flutter 3.44.7. Writes the bundle the engine would load.
flutter build bundle
ls build/flutter_assets/assets/images/

# Or check what shipped inside a built APK:
unzip -l build/app/outputs/flutter-apk/app-debug.apk | grep flutter_assets
```

## Варианты, которые приводят на эту страницу

- **`Unable to load asset: "fonts/Inter-Regular.ttf"`**. Шрифты объявляются в `flutter: fonts:`, а не в `assets:`, и имя семейства в вашем `TextStyle` должно совпадать со значением `family:`, а не с именем файла. Механика сбоя и логика исправления те же самые.
- **`Unable to load asset` из `SvgPicture.asset`**. `flutter_svg` грузит через тот же `AssetBundle`, так что ошибка принадлежит фреймворку, а не пакету. Всё сказанное выше применимо без изменений.
- **Ассет существует, но "has empty data"**. Понимайте эту фразу буквально. Обычный виновник - Git LFS: репозиторий, где изображения отслеживаются через LFS, при выгрузке на раннере CI без `lfs: true` оставляет текстовый указатель на 130 байт вместо PNG. Сборка проходит, ключ в bundle есть, а декодирование падает. Проверяйте размер файла раньше всего остального. Правило в `.gitignore` или `.dockerignore`, исключающее `assets/`, даёт ту же картину "локально работает, в CI падает", и её стоит исключить, когда вы [прогоняете сборки для нескольких версий Flutter в одном пайплайне](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- **Ломается только во Flutter web и только после развёртывания**. Если приложение размещено по вложенному пути, `build/web/index.html` нуждается в `<base href="/my-app/">`, а сборка - в `flutter build web --base-href /my-app/`. Без этого движок запрашивает `/assets/...` от корня домена и получает 404, который проявляется как эта ошибка. Та же ловушка касается [сборки WebAssembly через `flutter build web --wasm`](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/).
- **Ломается только в `flutter test`**. Ассеты, объявленные в `pubspec.yaml`, в тестах виджетов работают: инструмент собирает `build/unit_test_assets/`, экспортирует путь как `UNIT_TEST_ASSETS`, а `mockFlutterAssets()` отдаёт ключи оттуда. Две вещи всё же ломаются. Ассеты, собираемые условно по flavor, в этот каталог не попадают, а golden-тесту, который рендерит `Image.asset`, нужно завершение загрузки, поэтому оборачивайте pump в `tester.runAsync` или вызывайте `precacheImage` перед сравнением.
- **Ломается только в release, но не в debug**. Это не проблема ассетов. Проверьте, достигается ли вообще ветка кода, формирующая ключ, и не собирается ли строка `const` из чего-то, что различается между режимами сборки.
- **Сборка Android даже не дошла до упаковки**. Если сбой происходит во время сборки, а не выполнения, перед вами [задача Gradle, упавшая с exit code 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/), и никакая правка pubspec тут не поможет.

Сквозная мысль: эта ошибка - промах поиска в структуре данных, которую создала ваша сборка. Так к ней и относитесь. Выведите `listAssets()`, сравните переданную строку с существующими строками, и исправление всегда окажется на одной из двух сторон этого сравнения.

## Связанные материалы

- [Исправление: Version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- когда падает сам `flutter pub get` из последовательности чистой пересборки.
- [Исправление: Gradle task assembleDebug failed with exit code 1 в сборке Flutter под Android](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- аналог на этапе сборки, когда bundle вообще не создаётся.
- [Как собрать web-приложение на Flutter с WebAssembly](/ru/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) -- разбирает настройку base href и пути размещения, которая ломает URL ассетов в web.
- [Как поддерживать несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- детали выгрузки и кеширования, стоящие за большинством сообщений про ассеты в духе "локально работает, в CI нет".
- [Исправление: Cannot provide both a color and a decoration во Flutter Container](/ru/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/) -- вторая ошибка, всплывающая при первой же попытке положить изображение под оформленный блок.

## Источники

- [Adding assets and images](https://docs.flutter.dev/ui/assets/assets-and-images), документация Flutter
- [Removal of AssetManifest.json](https://docs.flutter.dev/release/breaking-changes/asset-manifest-dot-json), документация Flutter
- [Класс `AssetManifest`](https://api.flutter.dev/flutter/services/AssetManifest-class.html), справочник API Flutter
- [`asset_bundle.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/services/asset_bundle.dart), flutter/flutter
- [`_binding_io.dart` и `mockFlutterAssets`](https://github.com/flutter/flutter/blob/stable/packages/flutter_test/lib/src/_binding_io.dart), flutter/flutter
- [Conditionally bundling assets based on flavor makes tests fail](https://github.com/flutter/flutter/issues/150296), flutter/flutter

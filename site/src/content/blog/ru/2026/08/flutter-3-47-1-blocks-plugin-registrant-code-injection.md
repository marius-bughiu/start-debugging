---
title: "Flutter 3.47.1 не даёт транзитивному пакету внедрить нативный код в ваше приложение"
description: "Хотфикс 3.47.1 проверяет идентификаторы классов и пакетов плагинов до того, как они попадут в GeneratedPluginRegistrant. Разбираем закрытую дыру, регулярное выражение, которое её закрывает, и остальные 11 исправлений релиза."
pubDate: 2026-08-21
tags:
  - "flutter"
  - "dart"
  - "security"
  - "flutter-tools"
lang: "ru"
translationOf: "2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection"
translatedBy: "claude"
translationDate: 2026-08-21
---

Flutter 3.47.1 вышел в канал stable 2026-08-19 вместе с Dart 3.13.1, ровно через неделю после того, как [3.47.0 сделал Impeller рендерером по умолчанию на десктопе](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/). Двенадцать задач для хотфикса Flutter это много, и одна из них вовсе не исправление краша. Это дыра в цепочке поставок на этапе сборки внутри `flutter_tools`.

## Идентификаторы плагинов попадали в сгенерированный нативный код без экранирования

Когда вы запускаете `flutter pub get` или `flutter build`, инструмент обходит граф транзитивных зависимостей и пишет `GeneratedPluginRegistrant` для каждой платформы. Значения `pluginClass` и android-поле `package` из `pubspec.yaml` каждого плагина подставляются в этот файл дословно, в шаблоны вида `new {{package}}.{{class}}()` для Java, `{{prefix}}{{class}}.register(...)` для Swift и `#import <{{name}}/{{class}}.h>` для Objective-C. Рендерер шаблонов работает с `htmlEscapeValues`, равным `false`, так что по пути ничего не экранируется.

Валидация проверяла лишь то, что эти поля являются строками. Я подтвердил это на локальном SDK 3.44.2, где `AndroidPlugin.validate` до сих пор представляет собой только проверку типа:

```dart
static bool validate(YamlMap yaml) {
  return (yaml['package'] is String && yaml[kPluginClass] is String) ||
      yaml[kDartPluginClass] is String ||
      yaml[kFfiPlugin] == true ||
      yaml[kDefaultPackage] is String;
}
```

Строка с точками с запятой, фигурными скобками и переводами строк такую проверку проходит. Поэтому зависимость с подобным объявлением вкомпилирует произвольный нативный код в любое приложение, которое от неё зависит:

```yaml
flutter:
  plugin:
    platforms:
      macos:
        pluginClass: "SomePlugin(); evilInjectedCall(); if (false) { SomePlugin"
```

Спешность патча объясняется охватом. Плагины собираются через `computeTransitiveDependencies`, без какого-либо явного согласия со стороны потребляющего приложения. Пакет тремя уровнями ниже в дереве зависимостей может это запустить, и полезная нагрузка выполнится на этапе сборки на машине разработчика или на CI-раннере, а не в рантайме приложения, где её могло бы поймать ревью.

## Что 3.47.1 требует взамен

[PR 191294](https://github.com/flutter/flutter/pull/191294) добавляет шаблон идентификатора и применяет его к каждому присутствующему полю-идентификатору, а не только к тем, которые делали объявление валидным:

```dart
final RegExp _pluginIdentifierPattern = RegExp(
  r'^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$',
);
```

Для путей к исходникам Dart действует отдельное правило, поскольку `fileName` и `dartFileName` подставляются в инструкцию `import`: `RegExp(r'^\w[\w./-]*\.dart$')` плюс явный отказ для любого значения, содержащего `..`.

Режимы отказа различаются по платформам. Некорректный идентификатор для Android, iOS, macOS, Linux или Windows заставляет `validate` вернуть false, и вы получаете `Invalid plugin specification <name>`. Веб-плагины падают с более конкретным сообщением инструмента: `The plugin <name> has an invalid pluginClass in its web plugin declaration.` Если вы сопровождаете плагин и ваша сборка внезапно падает на 3.47.1, проверьте, что объявленный класс является обычным идентификатором с точками.

## Остальные одиннадцать

Прочая часть хотфикса это в основном мелкие неудобства тулинга, но два пункта оправдывают обновление сами по себе: починен hot restart для веб-сборок WASM ([flutter/186445](https://github.com/flutter/flutter/issues/186445)), а hot reload больше не игнорирует правки в пакетах-участниках pub workspace, лежащих внутри `lib/` корневого пакета ([flutter/190284](https://github.com/flutter/flutter/issues/190284)). Также вошли: гонка в SwiftPM, бросавшая `FileSystemException` при параллельных многоцелевых сборках для iOS и macOS, краш `impellerc` в Windows на путях с символами Unicode, взаимоблокировка в отладочных адаптерах, когда целевой процесс завершается до подключения VM service, и опт-ин на уровне проекта для Flutter GPU в release-сборках под Linux и Windows.

```bash
flutter channel stable
flutter upgrade
```

Полный список находится в [журнале хотфиксов Flutter](https://github.com/flutter/flutter/blob/main/CHANGELOG.md).

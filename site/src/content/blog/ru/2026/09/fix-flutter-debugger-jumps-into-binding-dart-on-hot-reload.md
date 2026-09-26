---
title: "Исправление: отладчик Flutter переходит в binding.dart при hot reload без какой-либо ошибки"
description: "Баг dwds во Flutter 3.35 для web отправлял ложную паузу при каждом hot reload. Обновитесь до Flutter 3.38+ или верните в VS Code режим 'Debug my code', чтобы фреймы пакетов пропускались."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "hot-reload"
  - "vs-code"
  - "debugging"
lang: "ru"
translationOf: "2026/09/fix-flutter-debugger-jumps-into-binding-dart-on-hot-reload"
translatedBy: "claude"
translationDate: 2026-09-26
---

Если вы запускаете web-приложение на Flutter из VS Code или Android Studio и каждый hot reload открывает `package:flutter/src/foundation/binding.dart` (обычно около строки 845) без какого-либо исключения, вы ничего не делаете неправильно. Это баг в dwds, сервисе отладки для web, который поставлялся с Flutter 3.35: во время hot reload он ставил Chrome на паузу, чтобы заново зарегистрировать точки останова, и сообщал IDE об этой внутренней паузе как о настоящей. Баг исправлен в dwds 25.1.0+1, который впервые попал в stable во Flutter 3.38.0. Обновитесь (текущая stable-версия 3.47.5). Если вы застряли на 3.35.x, верните режим отладки VS Code в строке состояния на "Debug my code" или передайте `--no-web-experimental-hot-reload`.

Всё, что описано ниже, проверено по исходникам Flutter 3.35.4, 3.35.7, 3.38.0 и 3.47.5, журналам изменений dwds 24.4.0+2 и 25.1.0+1 и схеме настроек Dart-Code 3.144.

## Ошибка в контексте

Текста ошибки нет, и именно это сбивает с толку. Вы сохраняете файл (или нажимаете кнопку hot reload), перезагрузка завершается, а затем редактор переключается на файл, который вы никогда не открывали:

```text
package:flutter/src/foundation/binding.dart   (line 845, highlighted as the current frame)

  @protected
  void postEvent(String eventKind, Map<String, dynamic> eventData) {
    developer.postEvent(eventKind, eventData);   // <- debugger "paused" here
  }
```

Панель CALL STACK показывает, что изолят на паузе, но не на исключении и не на точке останова. Вы нажимаете Continue, приложение продолжает работать, и при следующей перезагрузке всё повторяется. Некоторые видят вместо этого другой файл, с сообщением вместо исходного кода:

```text
Could not load source 'package:flutter/src/foundation/binding.dart': Bad state: source reference is no longer valid.
```

В вариантах того же отчёта фигурируют `package:flutter/src/painting/decoration_image.dart` или `package:provider/src/devtool.dart`. Этот список оказывается лучшей подсказкой к тому, что происходит.

Типичный отчёт выглядит так: Flutter 3.35.4 или 3.35.5 на канале stable, Dart 3.9.2, запуск в Chrome, отладка из VS Code. Тот же симптом подтверждён в Android Studio. При запуске `flutter run -d chrome` в терминале он не проявляется, потому что в терминале ничто не переходит к исходному файлу.

## Почему отладчик останавливается в binding.dart

Во Flutter 3.35 stateful hot reload для web включён по умолчанию (флаг `--web-experimental-hot-reload` переключён на `defaultsTo: true`). Чтобы точки останова продолжали работать после перезагрузки, dwds ставит JavaScript-изолят в Chrome на паузу, заново регистрирует точки останова для нового кода и возобновляет выполнение. Эта пауза является деталью реализации. Баг состоял в том, что dwds 24.4.x всегда отправлял событие `PauseInterrupted` при постановке на паузу, в том числе при этой внутренней.

IDE не может отличить одно от другого. Как сформулировал сопровождающий Dart-Code Danny Tuppeny в [flutter/flutter#176693](https://github.com/flutter/flutter/issues/176693), событие `PauseInterrupted`, отправленное во время перезагрузки, "to DAP/VS Code looks like a legitimate pause" (для DAP/VS Code выглядит как законная пауза). Поэтому VS Code делает то же, что и при любой паузе: берёт верхний фрейм стека вызовов и открывает этот файл.

Какой именно файл? Тот Dart-код, который выполнялся в момент, когда Chrome встал на паузу. В debug-сборке Flutter постоянно отправляет события VM service: `SchedulerBinding` отправляет `Flutter.Frame` после кадров, расширения сервиса отправляют `Flutter.ServiceExtensionStateChanged`, и всё это проходит через один метод в `BindingBase`:

```dart
// Flutter 3.35.4, packages/flutter/lib/src/foundation/binding.dart, lines 843-846
@protected
void postEvent(String eventKind, Map<String, dynamic> eventData) {
  developer.postEvent(eventKind, eventData);
}
```

В исходниках 3.35.4 `developer.postEvent(eventKind, eventData);` находится ровно на строке 845, поэтому в стольких отчётах упоминается именно она. Другие файлы, в которые попадают люди, тоже вызывают `postEvent`: `decoration_image.dart` вызывает `developer.postEvent('Flutter.ImageSizesForFrame', ...)`, а `devtool.dart` из `provider` отправляет собственные события для расширения Provider DevTools. Пауза приходится на того, кто в этот момент обращается к VM service.

Вариант с "source reference is no longer valid" (ссылка на исходник больше не действительна) представляет собой ту же паузу с более неудачным таймингом: перезагрузка только что подменила скрипты, поэтому ссылка на скрипт, привязанная к устаревшему фрейму, больше не разрешается.

### Почему это видели не все разработчики

VS Code переходит к фрейму на паузе, только если считает его вашим кодом. Dart-Code решает это с помощью двух настроек, обе по умолчанию `false`:

- `dart.debugSdkLibraries`: помечает библиотеки `dart:*` как доступные для отладки.
- `dart.debugExternalPackageLibraries`: помечает внешние пакеты pub как доступные для отладки, и схема Dart-Code прямо указывает, что сюда входит `package:flutter`.

Это те же настройки, между которыми переключается элемент строки состояния во время сеанса отладки: "Debug my code", "Debug my code + packages", "Debug my code + packages + SDK". При режиме по умолчанию "Debug my code" каждый фрейм ложной паузы принадлежит `package:flutter`, ни один из них не считается пользовательским кодом, и VS Code некуда переходить. Если же вы когда-то переключились на "+ packages", чтобы зайти в метод фреймворка, `binding.dart` становился "вашим" кодом, и редактор переходил туда при каждой перезагрузке. Поэтому же участник команды Flutter сначала проверил 3.35.6, не увидел проблемы и пометил issue как исправленный, пока Danny не указал, что на записи использовался режим "Debug my code".

## Минимальное воспроизведение

Это нужно, только если вы хотите убедиться, что столкнулись именно с этим багом, а не с чем-то другим.

```bash
# Flutter 3.35.4 stable, Dart 3.9.2, Chrome, VS Code with Dart-Code
flutter create repro_binding
cd repro_binding
code .
```

```jsonc
// .vscode/settings.json -- Flutter 3.35.x, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": true
}
```

Выберите Chrome в качестве устройства, нажмите F5, измените текст счётчика в `lib/main.dart` и сохраните. На 3.35.x редактор откроет `binding.dart` на строке `developer.postEvent`. Удалите настройку (или выберите "Debug my code" в строке состояния), и переходы прекратятся, хотя изолят по-прежнему ненадолго встаёт на паузу. На Flutter 3.38.0 и новее не происходит ни того, ни другого.

## Исправление 1: обновитесь до Flutter 3.38 или новее

Это настоящее исправление. Изменение в dwds: [dart-lang/webdev#2695](https://github.com/dart-lang/webdev/pull/2695), "Don't send PauseInterrupted event during a hot reload" (не отправлять событие PauseInterrupted во время hot reload), слито 2025-10-09. Вместо отправки обычного события паузы `ChromeProxyService` теперь сообщает отладчику, что пауза внутренняя, а отладчик сигнализирует о завершении через completer, а не через событие. Исправление вышло в хотфиксе dwds `25.1.0+1`, запись в журнале изменений которого гласит "Fix an issue in `reloadSources` where a `PauseInterrupted` event was sent" и ссылается на [dart-lang/sdk#61560](https://github.com/dart-lang/sdk/issues/61560).

Для вас важно, какую версию dwds закрепляет ваш Flutter SDK в `packages/flutter_tools/pubspec.yaml`:

| Flutter | Закреплённая версия dwds | Ложная пауза при hot reload в web |
| --- | --- | --- |
| 3.32.8 | 24.3.10 | Нет (stateful hot reload для web по умолчанию выключен) |
| 3.35.4 | 24.4.0+2 | Да |
| 3.35.7 (последний хотфикс 3.35) | 24.4.0+2 | Да |
| 3.38.0 | 25.1.0+2 | Нет |
| 3.47.5 (stable, сентябрь 2026) | 27.1.2 | Нет |

Исправление так и не было перенесено (cherry-pick) в ветку 3.35, поэтому никакой хотфикс 3.35 не поможет. Проверьте, на какой версии вы находитесь, и двигайтесь вперёд:

```bash
# any Flutter version
flutter --version
flutter channel stable
flutter upgrade
```

Если проект закрепляет SDK через FVM или файл `.flutter-version`, обновите версию там, иначе IDE продолжит запускать старый SDK даже после обновления глобального:

```bash
# FVM 3.x
fvm install 3.47.5
fvm use 3.47.5
```

Затем перезапустите сеанс отладки. Запущенный сеанс сохраняет свой исходный процесс `flutter run`, а этот процесс держит старую версию dwds.

## Исправление 2: верните VS Code в режим "Debug my code"

Если обновиться пока нельзя (зафиксированный образ CI, плагин без поддержки новых версий Dart), скройте симптом. Во время сеанса отладки нажмите на элемент режима отладки в левой части строки состояния и выберите "Debug my code" (отлаживать только мой код). Или задайте это для рабочей области:

```jsonc
// .vscode/settings.json -- Flutter 3.35.x workaround, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": false,
  "dart.debugSdkLibraries": false
}
```

Именно этот обходной путь рекомендовал Danny в issue. Изолят по-прежнему ненадолго встаёт на паузу во время перезагрузки, но поскольку каждый фрейм находится в `package:flutter` или `dart:*`, VS Code считает их все внешним кодом и не перехватывает фокус. Когда действительно нужно зайти внутрь пакета, переключитесь на "+ packages" для этого сеанса и мирьтесь с переходами, пока не переключитесь обратно.

В Android Studio и IntelliJ это не поможет: там нет аналогичного переключателя для этого случая. Используйте там исправление 3.

## Исправление 3: отключите stateful hot reload для web на 3.35

Грубый вариант: вернуться к формату web-модулей, существовавшему до 3.35, который вообще не выполняет этот танец с паузой и повторной регистрацией:

```bash
# Flutter 3.35.x, terminal
flutter run -d chrome --no-web-experimental-hot-reload
```

Для VS Code укажите это в `launch.json`, чтобы настройка действовала только для этого проекта:

```jsonc
// .vscode/launch.json -- Flutter 3.35.x, Dart-Code extension
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "web (no stateful reload)",
      "type": "dart",
      "request": "launch",
      "program": "lib/main.dart",
      "deviceId": "chrome",
      "toolArgs": ["--no-web-experimental-hot-reload"]
    }
  ]
}
```

Пользовательская настройка `dart.flutterRunAdditionalArgs` тоже работает, но она применяется ко всем проектам на машине, и именно так люди год спустя забывают, что она там есть. В Android Studio откройте Run > Edit Configurations, выберите конфигурацию Flutter и укажите `--no-web-experimental-hot-reload` в поле "Additional run args".

Цена ощутима: без нового формата модулей web-цель возвращается к старому поведению, при котором перезагрузка перезапускает приложение, и вы теряете состояние при каждом сохранении. Считайте это временным мостом до обновления и удалите настройку после него. Во Flutter 3.47.5 справка по флагу уже гласит "(deprecated; will be removed in a future release)", так что оставшаяся запись в `toolArgs` со временем сломает вашу конфигурацию запуска.

## Подводные камни и похожие случаи

**Вы на 3.38 или новее, а проблема всё равно возникает.** Прежде всего посмотрите на заголовок панели CALL STACK. Если там написано "Paused on exception", это не баг dwds, а настоящее исключение, и в панели Breakpoints будет отмечен пункт "Uncaught Exceptions" или "All Exceptions". При "All Exceptions" отладчик также останавливается на исключениях, которые код фреймворка или пакетов выбрасывает и сам же перехватывает. Снимите отметку, перезагрузите и посмотрите, исчезнет ли пауза. Если написано "Paused on breakpoint", откройте панель Breakpoints: VS Code сохраняет точки останова для каждой рабочей области, включая те, что вы поставили внутри `binding.dart`, когда месяцы назад проходили по коду фреймворка. Удалите её.

**Это происходит на Android, iOS или desktop.** Ложная пауза возникала только в web, потому что жила в dwds, который работает только для web-целей. Нативный VM service не ставит изолят на паузу для повторной регистрации точек останова при перезагрузке. На мобильной или desktop-цели остановка в `binding.dart` означает исключение или забытую точку останова, так что воспользуйтесь проверками выше.

**Hot reload роняет сеанс отладки вместо паузы.** Во Flutter 3.35.2 был отдельный баг web, при котором hot reload выбрасывал ошибку из `dwds/src/injected/client.js` и ломал сеанс ([flutter/flutter#174932](https://github.com/flutter/flutter/issues/174932)). Другой баг, то же лекарство: обновиться.

**Страница показывает старый код после перезагрузки.** Если перезагрузка "работает", но браузер выполняет устаревшую сборку, дело в кешировании, а не в отладчике. См. [почему Flutter web отдаёт устаревшую закешированную сборку после перезагрузки](/ru/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**Hot reload зависает при установленной точке останова.** Если у вас есть точка останова внутри переопределения `State.reassemble` (или в коде, который оно вызывает), вызов сервиса `ext.flutter.reassemble` останавливается там при каждой перезагрузке, и инструмент может не дождаться ответа по таймауту ([flutter/flutter#23285](https://github.com/flutter/flutter/issues/23285)). Это настоящая точка останова, выполняющая свою работу, а не баг dwds: продолжите выполнение дальше или переместите её.

## Связанные материалы

- Если вы профилируете, а не отлаживаете, статья [как профилировать подтормаживания во Flutter-приложении с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) описывает представление Performance, которое потребляет эти события `Flutter.Frame`.
- [Почему `appFlavor` становится null после hot restart с `flutter attach`](/ru/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/): ещё один случай, когда путь перезагрузки ведёт себя иначе, чем обычный запуск.
- [MCP-сервер Dart и Flutter](/ru/2026/05/dart-flutter-mcp-server-claude-code-cursor/) общается с тем же VM service и DTD, перед которыми dwds стоит в web.
- Выбираете web-рендерер одновременно с обновлением? [CanvasKit или skwasm для Flutter web в 2026 году](/ru/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/) разбирает компромиссы.

## Источники

- [dart-lang/sdk#61560: Hot Reload opens `binding.dart` at line 845 on every reload (no errors shown)](https://github.com/dart-lang/sdk/issues/61560)
- [flutter/flutter#176693: [Web] Hot Reload jumping on binding.dart file even if "uncaught exceptions" are turned off](https://github.com/flutter/flutter/issues/176693)
- [flutter/flutter#174951: Error when hot reload since latest versions](https://github.com/flutter/flutter/issues/174951)
- [dart-lang/webdev#2695: Don't send PauseInterrupted event during a hot reload](https://github.com/dart-lang/webdev/pull/2695)
- [Журнал изменений dwds на pub.dev](https://pub.dev/packages/dwds/changelog)
- [Документация API BindingBase.reassembleApplication](https://api.flutter.dev/flutter/foundation/BindingBase/reassembleApplication.html)
- [Документация Flutter: Hot reload](https://docs.flutter.dev/tools/hot-reload)
- [Что нового во Flutter 3.38](https://blog.flutter.dev/whats-new-in-flutter-3-38-3f7b258f7228)

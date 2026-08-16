---
title: "Flutter 3.47 делает Impeller рендерером по умолчанию в Windows, Linux и macOS"
description: "Стабильный Flutter 3.47.0 переводит десктопные приложения со Skia на Impeller, не меняя ни строки в коде вашего runner. Что именно меняется, как отключить Impeller на каждой платформе и почему такое отключение временное."
pubDate: 2026-08-16
tags:
  - "flutter"
  - "dart"
  - "impeller"
  - "windows"
lang: "ru"
translationOf: "2026/08/flutter-3-47-impeller-default-renderer-on-desktop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Flutter 3.47.0 вышел в стабильном канале 2026-08-12 и принёс с собой Dart 3.13.0. Основное внимание достаётся отдельным пакетам `material_ui` и `cupertino_ui` версии 1.0, которые продолжают разделение, начатое в [Flutter 3.44](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/). Изменение, которое на самом деле влияет на то, как ваше приложение отрисовывается, гораздо тише: Impeller стал рендерером по умолчанию в Windows, Linux и macOS.

## В вашем проекте не меняется ничего, и в этом вся проблема

Десктопный runner представляет собой сгенерированный код, который лежит в вашем репозитории, поэтому легко предположить, что смена рендерера придёт в виде диффа шаблона, который можно просмотреть. Этого не происходит. В Flutter 3.44 точка входа для Windows выглядит так, и никакого выбора рендерера в ней нет:

```cpp
flutter::DartProject project(L"data");

std::vector<std::string> command_line_arguments = GetCommandLineArguments();
project.set_dart_entrypoint_arguments(std::move(command_line_arguments));
```

`ImpellerSwitch` в SDK 3.44 не встречается нигде. Обновление до 3.47 оставляет `windows\runner\main.cpp` побайтово тем же и меняет значение по умолчанию под ним. Если сборка под Windows или Linux после обновления начала показывать визуальные регрессии, проверять в первую очередь нужно рендерер, а не дерево виджетов.

## Как отключить, по платформам

Для локальной отладки один флаг покрывает все три десктопные платформы:

```bash
flutter run --no-enable-impeller
```

Для разворачиваемой сборки придётся править runner. Windows, файл `windows\runner\main.cpp`:

```cpp
flutter::DartProject project(L"data");
project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
```

Linux, файл `linux/runner/my_application.cc`:

```c
g_autoptr(FlDartProject) project = fl_dart_project_new();
fl_dart_project_set_enable_impeller(project, FALSE);
```

macOS, в корневом `<dict>` файла `Info.plist`:

```xml
<key>FLTEnableImpeller</key>
<false />
```

Относитесь ко всем трём вариантам как к временной мере. [Документация Impeller](https://docs.flutter.dev/perf/impeller) прямо говорит, что возможность отключения будет удалена в одном из будущих релизов, тем же путём уже прошли iOS и Android. Используйте переключатель, чтобы разблокировать релиз, а затем заведите баг по отрисовке.

## Что даёт переход

Impeller ориентируется на Metal в macOS и на Vulkan в Windows и Linux вместо прохода через OpenGL-путь Skia. Конкретный выигрыш касается шейдеров: Impeller компилирует их заранее, во время сборки, а не при первом использовании, и именно это убирает подтормаживание при первом запуске, на которое пользователи десктопа и мобильных устройств жалуются годами. Flutter 3.47 также включает рендеринг через поля знаковых расстояний для текста и векторных кривых в macOS, Linux и Windows, поэтому края глифов и кривые получаются чётче, а широкий цветовой охват в macOS включён по умолчанию.

## Остальное из 3.47, что стоит прочитать перед обновлением

- Минимальные целевые версии поднимаются до iOS 15 и macOS 12 ради совместимости с Xcode 27.
- Widget Previews переходит в стабильный статус.
- Win32 и Linux получают поддержку всплывающих окон, а оконный API переименовывает `preferredSize` в `size` и `preferredConstraints` в `constraints`.
- Новые проекты Android используют шаблоны с AGP 9 и новее и встроенной поддержкой Kotlin.

Полный список есть в [заметках о выпуске Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0) и в [анонсе](https://flutter.dev/blog/whats-new-in-flutter-3-47). Если вы выпускаете десктопное приложение на Flutter, прогоните набор визуальных регрессионных тестов до того, как вливать обновление SDK.

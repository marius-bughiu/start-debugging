---
title: "Миграция настольного приложения Flutter для Windows или Linux на Impeller (Flutter 3.47)"
description: "Flutter 3.47 делает Impeller рендерером по умолчанию в Windows и Linux. Что на самом деле меняется под капотом (это по-прежнему OpenGL ES, а не Vulkan), как сравнить с Skia на готовой сборке, переключатель отключения для отдельной машины в релизных сборках и почему golden-тесты ничего не заметят."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "impeller"
  - "windows"
  - "linux"
lang: "ru"
translationOf: "2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller"
translatedBy: "claude"
translationDate: 2026-10-08
---

Flutter 3.47.0 (стабильная версия с 2026-08-12, Dart 3.13) переключает настольные приложения для Windows и Linux со Skia на Impeller без единой правки в коде вашего runner. Для большинства приложений миграция занимает полдня: обновить Flutter, убедиться, что в журнале движка есть строка `Using the Impeller rendering backend (OpenGLESSDF)`, сравнить скриншоты и время кадров с запуском через `--no-enable-impeller`, и только потом решать, выпускать ли приложение с Impeller или временно закрепить Skia в `windows/runner/main.cpp` или `linux/runner/my_application.cc`. Ломается в основном внешний вид: растеризация текста (Impeller принудительно включает текст на основе полей расстояний со знаком, а также новую гамма-коррекцию), сглаживание на GPU без неявного MSAA и отдельные пользовательские шейдеры. Всё ниже проверено по исходному коду движка Flutter 3.47.0 и `flutter_tools`.

## Что на самом деле меняется под вашим приложением

Сначала о том, что **не** меняется: графический API. Embedder для Windows по-прежнему рисует через OpenGL ES поверх ANGLE, который транслирует вызовы в Direct3D 11. `flutter_windows_engine.cc` в 3.47.0 создаёт `egl::Manager` и `CompositorOpenGL` независимо от рендерера, а embedder для Linux знает только два типа рендерера: `opengl` и `software`. Пути через Vulkan нет ни в одном из настольных embedder. Impeller на десктопе - это GLES-бэкенд Impeller в том же GL-контексте, который раньше использовала Skia. На macOS это бэкенд Impeller на Metal.

Меняется всё, что находится выше вызовов GL:

- **Шейдеры собираются заранее.** Impeller поставляется с фиксированным, заранее собранным набором шейдеров вместо генерации и компиляции шейдеров при первом использовании, из-за чего у Skia и возникали подтормаживания при первом запуске.
- **Текст рисуется через SDF.** В Windows embedder добавляет `--impeller-use-sdfs=true`, когда Impeller включён, если вы не передали этот переключатель сами. В Linux он добавляет `--impeller-use-sdfs` безусловно. В примечаниях к релизу 3.47 также добавлена гамма-коррекция глифов на обеих платформах ([#187122](https://github.com/flutter/flutter/pull/187122), [#187871](https://github.com/flutter/flutter/pull/187871)).
- **Значение по умолчанию живёт в коде движка, а не в вашем проекте.** `ImpellerSwitch::Default` означает "как решит движок", и в 3.47 это `true` в Windows ([#188140](https://github.com/flutter/flutter/pull/188140)) и `TRUE` в `fl_dart_project_init` в Linux ([#187573](https://github.com/flutter/flutter/pull/187573)). Сгенерированный runner побайтно совпадает с тем, что был в 3.44.

Именно поэтому нужен осознанный проход миграции. Ничто в вашем диффе не сообщает ревьюерам, что рендерер изменился.

## Что ломается

| Область | Изменение в 3.47 | Серьёзность |
| --- | --- | --- |
| Отрисовка текста | SDF-глифы и гамма-коррекция; края и насыщенность глифов слегка смещаются | средняя |
| Сглаживание | Windows GPU без неявного MSAA требуют пути с внеэкранным MSAA ([#190374](https://github.com/flutter/flutter/pull/190374), перенесён в 3.47 через cherry-pick) | средняя |
| Скриншоты интеграционных тестов | Попиксельные различия с эталонами, снятыми на Skia | средняя |
| Пользовательские фрагментные шейдеры | Компилируются `impellerc` для цели GLES; ошибки конкретных драйверов проявляются иначе | от низкой до средней |
| Golden-тесты `flutter test` | По умолчанию не затронуты (см. подводные камни) | нет |
| Код runner | Шаблон не изменился; для отказа нужна ручная правка | низкая |

## Проверки перед началом

- Где-нибудь должен остаться установленным Flutter 3.44.x (FVM, второй чекаут или образ CI), чтобы можно было собрать эталон на Skia. Если вы уже запускаете [несколько версий Flutter из одного конвейера CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), добавьте 3.47 как новую ветку, а не заменяйте старую.
- Список машин, которые вы действительно поддерживаете: как минимум один компьютер с Windows и встроенной графикой Intel, один с дискретным GPU NVIDIA или AMD и одна машина с Linux и драйверами Mesa. Виртуальные машины и сеансы RDP заслуживают отдельной строки.
- Несколько экранов, нагружающих отрисовку: плотный текст, повёрнутый или масштабированный текст, custom painter, размытие и тени, любой шейдер на `FragmentProgram`.
- Если вы выпускаете и macOS из той же кодовой базы, учтите, что 3.47 поднимает минимальную версию до macOS 12. Это [отдельная миграция](/ru/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/), с которой вы столкнётесь при том же обновлении SDK.

## Шаги миграции

1. **Снимите эталон на Skia в 3.44.** Соберите profile-сборки и сделайте скриншоты ваших нагруженных экранов на каждой целевой машине:

   ```bash
   # Flutter 3.44.x
   flutter build windows --profile
   flutter build linux --profile
   ```

   Запишите и время кадров. Достаточно [трассировки производительности в DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) за первые 10 секунд после запуска и за самую тяжёлую прокрутку. Проверка: на каждую машину есть одна трассировка и один набор скриншотов.

2. **Обновитесь до 3.47 и пересоберите.**

   ```bash
   flutter upgrade
   flutter --version   # expect Flutter 3.47.x, Dart 3.13.x
   flutter clean
   flutter build windows --profile
   ```

   Проверка: `git status` не показывает изменений в `windows/runner/` и `linux/runner/`. Если они есть, значит кто-то выполнил `flutter create .`, и этот дифф нужно разобрать отдельно.

3. **Убедитесь, какой бэкенд выбрал движок.** Запустите приложение через `flutter run -d windows` (или `-d linux`) и найдите стартовую строку движка:

   ```text
   [IMPORTANT:flutter/shell/platform/embedder/embedder_surface_gl_impeller.cc(126)] Using the Impeller rendering backend (OpenGLESSDF).
   ```

   `OpenGLESSDF` означает Impeller с SDF-текстом, это ожидаемый результат на обеих платформах. Если вместо этого вы видите `Could not create Impeller context.`, значит GL-контекст не удовлетворил требованиям Impeller, и сначала нужно разбираться с драйвером. Обратите внимание: в поверхности embedder нет тихого отката на Skia, поверхность Impeller просто оказывается недействительной. Проверка: строка появляется ровно один раз на окно.

4. **Сравните тот же бинарный файл со Skia.** Для `flutter run` флаг работает на всех настольных платформах:

   ```bash
   flutter run -d windows --profile --no-enable-impeller
   ```

   Для уже собранного debug- или profile-бинарника рендерер можно переключить переменными окружения с переключателями движка, которые оба настольных embedder читают через `GetSwitchesFromEnvironment()`:

   ```powershell
   # Flutter 3.47, Windows, debug or profile build only
   $env:FLUTTER_ENGINE_SWITCHES = "1"
   $env:FLUTTER_ENGINE_SWITCH_1 = "enable-impeller=false"
   .\build\windows\x64\runner\Profile\my_app.exe
   ```

   ```bash
   # Flutter 3.47, Linux, debug or profile build only
   FLUTTER_ENGINE_SWITCHES=1 FLUTTER_ENGINE_SWITCH_1=enable-impeller=false \
     ./build/linux/x64/profile/bundle/my_app
   ```

   Это самый быстрый способ дать тестировщику одну сборку и два ярлыка. Проверка: стартовая строка в журнале исчезает, когда переключатель задан, и возвращается, когда он не задан.

5. **Сравните скриншоты и трассировки.** Положите рядом скриншоты Skia из 3.44, Skia из 3.47 и Impeller из 3.47. Полезнее всего сравнение Skia 3.47 с Impeller 3.47, потому что оно отделяет рендерер от всех остальных изменений в релизе. Ожидайте, что текст везде будет выглядеть немного иначе. Ищите то, что неправильно, а не то, что отличается: обрезанные глифы, пропавшие тени, зубчатые края у скруглённых прямоугольников, чёрные области. Проверка: каждое отличие либо принято, либо имеет минимальный воспроизводящий пример.

6. **Примите решение и при необходимости закрепите Skia в runner.** Если вы нашли реальную регрессию, отключите Impeller в поставляемой сборке. В Windows, в `windows/runner/main.cpp`:

   ```cpp
   // Flutter 3.47, windows/runner/main.cpp
   flutter::DartProject project(L"data");
   project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
   ```

   В Linux, в `linux/runner/my_application.cc`, перед `fl_view_new(project)`:

   ```c
   // Flutter 3.47, linux/runner/my_application.cc
   g_autoptr(FlDartProject) project = fl_dart_project_new();
   fl_dart_project_set_enable_impeller(project, FALSE);
   ```

   Проверка: пересоберите, запустите и убедитесь, что строки `Using the Impeller rendering backend` больше нет.

7. **Заведите баг в тот же день.** В [документации Impeller](https://docs.flutter.dev/perf/impeller) сказано, что возможность отказа будет удалена в одном из будущих релизов, как это было на iOS. Создайте issue с префиксом `[Impeller]` в заголовке, минимальным воспроизводящим примером, версиями GPU и драйвера, скриншотами и архивом с трассировкой производительности. Проверка: ссылка на issue лежит в комментарии рядом со строкой отказа, чтобы тот, кто будет её удалять, знал, зачем она там.

## Переключатель отключения для отдельной машины в релизных сборках

Приём с `FLUTTER_ENGINE_SWITCHES` из шага 4 не работает в релизных сборках. `engine_switches.cc` оборачивает весь поиск в `#ifndef FLUTTER_RELEASE`, поэтому поставляемое приложение его игнорирует. Если вы хотите выпускать Impeller, но оставить запасной выход для одного клиента, у которого ноутбук 2017 года рисует чёрное окно, читайте собственную переменную окружения в runner:

```cpp
// Flutter 3.47, windows/runner/main.cpp
#include <cwchar>

flutter::DartProject project(L"data");

wchar_t value[8];
DWORD length = ::GetEnvironmentVariableW(L"MYAPP_DISABLE_IMPELLER", value, 8);
if (length > 0 && length < 8 && std::wcscmp(value, L"1") == 0) {
  project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
}
```

```c
// Flutter 3.47, linux/runner/my_application.cc
g_autoptr(FlDartProject) project = fl_dart_project_new();
if (g_strcmp0(g_getenv("MYAPP_DISABLE_IMPELLER"), "1") == 0) {
  fl_dart_project_set_enable_impeller(project, FALSE);
}
```

Тогда поддержка сможет попросить затронутого пользователя задать одну переменную, а не ждать новой сборки. Значение в реестре или строка в файле конфигурации рядом с исполняемым файлом работают так же, если переменные окружения неудобны вашим пользователям. Считайте это временными лесами с тем же сроком жизни, что и у возможности отказа в движке.

## Проверка результата

После миграции на каждой машине вашей матрицы:

- Приложение запускается, а в журнале есть `OpenGLESSDF` (или вообще нет строки про Impeller, если вы закрепили Skia).
- Интеграционные тесты проходят. Тестам на скриншотах нужны новые эталоны; пересоздайте их на 3.47 осознанно, а не позволяйте массовому запуску "update goldens" скрыть настоящую регрессию.
- При первом запуске после чистой установки на временной шкале нет подтормаживаний из-за компиляции шейдеров. Это улучшение, ради которого всё затевается, поэтому измерьте его.
- Время кадров в установившемся режиме на самом тяжёлом экране укладывается в ваш бюджет. Impeller быстрее не на каждом кадре; он более предсказуем.
- Быстрое изменение размера окна не приводит к падению в Linux (падение при изменении размера было исправлено в цикле 3.47 в [#187626](https://github.com/flutter/flutter/pull/187626), и это веская причина не брать cherry-pick из более старой бета-версии).

## План отката

Откат дешёвый и обратимый в обе стороны. Можно либо вернуться на 3.44.x, где Impeller в Windows и Linux по умолчанию никогда не включался, либо остаться на 3.47 и добавить отказ в runner из шага 6. Второй вариант лучше: вы сохраняете все остальные исправления 3.47 и можете вернуться, удалив одну строку. Только не рассчитывайте, что возможность отказа просуществует вечно.

## Подводные камни

**Переключатели окружения важнее переключателя проекта в Windows.** В конструкторе `FlutterWindowsEngine` сначала читается `ImpellerSwitch` проекта, затем цикл по переключателям окружения перезаписывает его. Разработчик, у которого в профиле оболочки остался `FLUTTER_ENGINE_SWITCH_1=enable-impeller=true`, увидит Impeller даже в ветке, где закреплено `Disabled`. Прежде чем отлаживать что-то ещё, проверьте `env`.

**`ImpellerSwitch::Default` - это не `Enabled`.** Если вы хотите намертво включить Impeller независимо от решений будущих релизов, явно задайте `ImpellerSwitch::Enabled`. `Default` следует за движком, и именно это изменилось под вами в 3.47.

**Golden-тесты `flutter test` не видят Impeller.** `flutter_tester_device.dart` запускает тестовую оболочку с `--enable-software-rendering --skia-deterministic-rendering`, если вы не передали `--enable-impeller`. Golden-тесты виджетов продолжат проходить после обновления, но это ничего не говорит о настольном рендерере. Impeller задействуют только интеграционные тесты, запускающие настоящий `.exe` или бандл Linux.

**В Linux отказ нужно задать до создания представления.** `fl_dart_project_set_enable_impeller` задаёт поле, которое `FlEngine` читает при запуске. Вызывайте его сразу после `fl_dart_project_new()` и до `fl_view_new(project)`, а не позже в `my_application_activate`.

**Ноутбуки с гибридной графикой выбирают GPU раньше, чем важен рендерер.** В Windows `DartProject::set_gpu_preference` со значением `flutter::GpuPreference::HighPerformancePreference` или `LowPowerPreference` определяет, какой адаптер использует ANGLE. Если регрессия воспроизводится только на ноутбуке с GPU Intel и NVIDIA одновременно, проверьте оба варианта предпочтения, прежде чем винить Impeller.

**Виртуальные машины и удалённые сеансы.** Машины без поддержки неявного MSAA получали чёрный экран в Windows раньше в цикле 3.47; это исправили [#187288](https://github.com/flutter/flutter/pull/187288) и резервный путь с внеэкранным MSAA в [#190374](https://github.com/flutter/flutter/pull/190374). Если вы видите чёрное окно в виртуальной машине, убедитесь, что у вас последний патч 3.47, прежде чем создавать новый issue.

**Пользовательские шейдеры.** Шейдеры `FragmentProgram` продолжают работать, но теперь их выполняет GLES-бэкенд Impeller на том драйвере, который предоставляют ANGLE или Mesa. Перепроверьте каждый файл `.frag` на самом старом поддерживаемом GPU и не полагайтесь на поведение точности, которое случайно работало под Skia.

**У возможности отказа есть срок.** Каждый добавленный отказ - это долг со сроком, который вы не контролируете. Положите рядом ссылку на issue и пересматривайте его при каждом обновлении Flutter.

## Связанные материалы

- Краткое описание этого изменения в день релиза: [Flutter 3.47 делает Impeller рендерером по умолчанию в Windows, Linux и macOS](/ru/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Измерение до и после: [как профилировать подтормаживания в приложении Flutter с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).
- Параллельный запуск 3.44 и 3.47: [поддержка нескольких версий Flutter в одном конвейере CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- Другая настольная миграция в том же релизе: [повышение минимальной версии развёртывания приложения Flutter для macOS до macOS 12](/ru/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).
- Аналогичный выбор рендерера для веба: [CanvasKit или skwasm для Flutter web в 2026 году](/ru/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/).

## Источники

- [Impeller rendering engine](https://docs.flutter.dev/perf/impeller) на docs.flutter.dev (состояние на десктопе, фрагменты для отказа, чек-лист отчёта об ошибке).
- [Примечания к релизу Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0).
- [flutter/flutter#188140](https://github.com/flutter/flutter/pull/188140): делает Impeller рендерером по умолчанию в Windows.
- [flutter/flutter#187573](https://github.com/flutter/flutter/pull/187573): включает Impeller в Linux по умолчанию.
- [flutter/flutter#188044](https://github.com/flutter/flutter/pull/188044): добавляет переключатель проекта для Windows.
- [flutter/flutter#187288](https://github.com/flutter/flutter/pull/187288): исправляет чёрный экран на пути OpenGL в Windows.
- Исходный код Flutter 3.47.0: `engine/src/flutter/shell/platform/windows/flutter_windows_engine.cc`, `engine/src/flutter/shell/platform/linux/fl_engine.cc`, `engine/src/flutter/shell/platform/common/engine_switches.cc` и `packages/flutter_tools/lib/src/test/flutter_tester_device.dart`.

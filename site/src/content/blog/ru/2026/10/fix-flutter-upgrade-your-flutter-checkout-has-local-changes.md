---
title: "Исправление: flutter upgrade сообщает \"Your flutter checkout has local changes that would be erased by upgrading\""
description: "flutter upgrade прерывается, если git status в папке SDK что-то выводит. Посмотрите, что там, восстановите pubspec.lock или выполните git stash -u, а --force используйте только в крайнем случае."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "git"
lang: "ru"
translationOf: "2026/10/fix-flutter-upgrade-your-flutter-checkout-has-local-changes"
translatedBy: "claude"
translationDate: 2026-10-29
---

`flutter upgrade` запускает `git status -s` внутри папки Flutter SDK и отказывается продолжать, если выведена хотя бы одна строка, в том числе про неотслеживаемые файлы, которые вы не собирались хранить. Найдите SDK командой `flutter --version --machine` (поле `flutterRoot`), выполните там `git status --short`, а затем либо восстановите файл (обычно `pubspec.lock`), либо отложите свои правки через `git stash push -u`, либо, если в SDK для вас ничего не важно, запустите `flutter upgrade --force`. Всё ниже проверено на Flutter 3.44.8 и 3.47.7/3.47.8 (stable, Dart 3.12.2) 2026-10-29.

## Ошибка в контексте

Вы запускаете `flutter upgrade` на машине, где точно не трогали сам Flutter, и получаете вот это:

```text
$ flutter upgrade
Your flutter checkout has local changes that would be erased by upgrading. If you want to keep these changes, it is recommended that you stash them via "git stash" or else commit the changes to a local branch. If it is okay to remove local changes, then re-run this command with "--force".
```

Код выхода равен 1, ничего не изменилось. Сообщение относится к git-репозиторию **SDK**, а не к репозиторию вашего приложения. `git status` в вашем приложении может быть совершенно чистым, а ошибка всё равно появится.

## Почему это происходит

Flutter SDK представляет собой git-клон `flutter/flutter`, а `flutter upgrade` по сути выполняет `git fetch` и `git reset --hard <new revision>` с несколькими проверками безопасности вокруг. Нужный код находится в `packages/flutter_tools/lib/src/commands/upgrade.dart`, и порядок действий имеет значение:

1. `git fetch --tags`, затем определяется upstream-ревизия вашей ветки (`stable`, `beta`, `main`).
2. Если вы уже на этой ревизии, выводится "Flutter is already up to date" и команда завершается с кодом 0. **Проверка локальных изменений не выполняется.**
3. Если передан `--verify-only`, выводится доступная версия и команда завершается.
4. Если у текущего коммита нет узнаваемого тега релиза и вы не передали `--force`, команда прерывается с сообщением "Unknown flutter tag".
5. Если вы не передали `--force` и `hasUncommittedChanges()` возвращает true, команда прерывается с ошибкой выше.
6. `git reset --hard <upstream revision>`, затем новый инструмент перезапускается через `flutter upgrade --continue`, чтобы заранее загрузить артефакты, выполнить `pub upgrade` в вашем проекте и запустить `flutter doctor`.

`hasUncommittedChanges()` является тонкой обёрткой над `git status -s`. В канале stable любой непустой вывод считается изменением. Начиная с Flutter 3.47.0 ([PR #184997](https://github.com/flutter/flutter/pull/184997)) каналы beta и main пропускают строки, оканчивающиеся на `pubspec.lock`, потому что main сам записывает в этот файл ограничения dev SDK. Для stable такого исключения нет.

Из использования `git status -s` напрямую следуют два вывода:

- **Неотслеживаемые файлы учитываются.** Случайный `notes.txt` в папке SDK блокирует обновление, хотя `git reset --hard` его никогда бы не удалил.
- **Файлы из gitignore не учитываются.** `.gitignore` SDK уже покрывает `.idea/`, `.vscode/*`, `.pub-cache/`, `.dart_tool/`, `bin/cache/`, `*.log` и все `*.lock`, кроме корневого `/pubspec.lock`. `.pub-cache/` добавили после [issue #128635](https://github.com/flutter/flutter/issues/128635), где snap-установка хранила кеш pub внутри SDK.

Поэтому настоящий вопрос звучит не как "есть ли у меня локальные изменения", а как "что выводит `git status --short` в папке SDK и кто это туда положил".

## Минимальное воспроизведение

Я воспроизвёл каждый случай на отдельном клоне `flutter/flutter`, сброшенном на тег `3.47.7`, то есть на один релиз позади `stable` (3.47.8). Чтобы не запускать только что клонированный код, я вызывал логику обновления из установленного Flutter 3.44.8 через скрытый флаг инструмента `--working-directory`, который направляет команду на другой чекаут и пропускает повторно входящую вторую половину. Проверка для канала stable побайтово совпадает в 3.44.8 и 3.47.8.

```bash
# Flutter 3.44.8 tool, scratch checkout at 3.47.7, upstream stable = 3.47.8
C=~/scratch/flutter
git -C "$C" reset -q --hard 3.47.7

echo hi > "$C/notes.txt"                       # untracked file only
flutter upgrade --working-directory="$C"
# Your flutter checkout has local changes that would be erased by upgrading. ...
# exit=1
```

Вот что получилось в каждом сценарии:

| Состояние чекаута SDK | `git status -s` | Результат `flutter upgrade` |
| --- | --- | --- |
| Чистый, на один релиз позади | (пусто) | Обновляется |
| Неотслеживаемый `notes.txt` | `?? notes.txt` | Заблокировано |
| Файлы в `.idea/`, `.pub-cache/`, `debug.log` | (пусто, видно только с `--ignored`) | Не заблокировано |
| Изменённый корневой `pubspec.lock` | ` M pubspec.lock` | Заблокировано |
| Изменён исходный код фреймворка + неотслеживаемый файл, `--force` | ` M packages/flutter/...`, `?? notes.txt` | Обновляется; правка фреймворка пропала, `notes.txt` остался |
| Уже на 3.47.8 и есть `?? notes.txt` | `?? notes.txt` | "Flutter is already up to date", код выхода 0 |

Последняя строка объясняет запутанную картину: лишний файл месяцами лежит без жалоб, а ошибка появляется только в день релиза, когда наконец есть куда обновляться.

## Самая частая причина: собственный `pubspec.lock` в SDK

Если `git status --short` показывает ` M pubspec.lock` и больше ничего, значит Flutter изменил собственный lock-файл. Репозиторий Flutter является рабочим пространством pub (pub workspace), и его корневой `pubspec.lock` остаётся единственным отслеживаемым lock-файлом в дереве. Всё, что запускает `pub upgrade` с корнем SDK в качестве проекта, перезаписывает его, потому что пакеты, опубликованные после релиза (например, более новый `objective_c`), удовлетворяют тем же ограничениям.

Вплоть до Flutter 3.44.x включительно `flutter upgrade` делал это сам с собой. Повторно входящий `flutter upgrade --continue` запускался с корнем SDK в качестве рабочего каталога, поэтому шаг "обновить пакеты вашего проекта" вызывал `findProjectRoot()`, который поднимается вверх от текущего каталога в поисках `pubspec.yaml`, находил `pubspec.yaml` самого SDK и запускал на нём `pub upgrade`. Обновление проходило успешно, оставляло изменённый lock-файл, и *следующее* обновление падало. Это [issue #187977](https://github.com/flutter/flutter/issues/187977), и оно совпадает с сообщениями вида "это происходит только на установках, которые уже обновлялись один раз".

Дрейф можно увидеть самостоятельно. На чистом чекауте тега `3.44.0` запуск `pub upgrade` в корне SDK с Dart 3.12.2 (линейка Dart, которая поставляется с 3.44) перезаписал lock-файл (14 добавлений, 6 удалений):

```bash
# Flutter 3.44.0 checkout, Dart 3.12.2, 2026-10-29
cd ~/scratch/flutter && dart pub upgrade
git diff --stat
#  pubspec.lock | 20 ++++++++++++++------
```

```diff
       name: jni
-    version: "1.0.0"
+    version: "1.1.1"
       name: jni_flutter
-    version: "1.0.1"
+    version: "1.0.4+1"
       name: objective_c
-    version: "9.2.3"
+    version: "9.3.0"
```

`objective_c` с 9.2.3 до 9.3.0 это точно тот же diff, что приведён в отчёте об ошибке. [PR #188794](https://github.com/flutter/flutter/pull/188794) исправил проблему: вторая половина теперь запускается в вашем исходном рабочем каталоге, и исправление вошло во Flutter 3.47.0. Так что если у вас 3.44.x, ожидайте эту ошибку ещё один раз на пути к 3.47, а затем она должна прекратиться.

У этого исправления есть подвох. Вторая половина теперь запускает `pub upgrade` для того проекта, который `findProjectRoot()` находит от **вашего** текущего каталога, а эта функция поднимается вверх. Если запустить `flutter upgrade` изнутри дерева SDK, например из `~/development/flutter/bin`, она снова найдёт `pubspec.yaml` SDK и испортит lock-файл и на 3.47. Запускайте обновления из домашнего каталога или из папки приложения, но никогда изнутри SDK. (Запуск из папки приложения обновляет зависимости этого приложения, это отдельная тема, она разобрана в статье [почему `pubspec.lock` меняется после `flutter upgrade`](/ru/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).)

## Исправление подробно

### 1. Найдите SDK и посмотрите, что там, прежде чем применять force

Не хватайтесь за `--force` первым делом. Сначала выясните, что именно там лежит.

```bash
# Flutter 3.44+ on macOS / Linux (needs jq)
SDK="$(flutter --version --machine | jq -r .flutterRoot)"
git -C "$SDK" status --short
git -C "$SDK" diff --stat
```

```powershell
# Flutter 3.44+ on Windows PowerShell
$sdk = (flutter --version --machine | ConvertFrom-Json).flutterRoot
git -C $sdk status --short
git -C $sdk diff --stat
```

`flutter doctor -v` выводит тот же путь в строке "Flutter version X on channel Y at <path>", если вы не хотите разбирать JSON. Для установки через Homebrew cask `flutterRoot` указывает на реальный чекаут (`/opt/homebrew/share/flutter` на моей машине), а не на символическую ссылку `bin/flutter`.

### 2a. Изменён только `pubspec.lock`: восстановите его

Это описанный выше случай, когда файл записал сам Flutter. Файл всё равно будет сгенерирован заново, поэтому отмените изменение и обновитесь как обычно:

```bash
# Flutter 3.44.x -> 3.47.x, stable channel
git -C "$SDK" checkout -- pubspec.lock
cd ~ && flutter upgrade
```

Запуск обновления из `~` не даёт второй половине найти `pubspec.yaml` внутри SDK.

### 2b. Вы намеренно изменили файлы фреймворка: отложите их в stash

Возможно, вы поправили виджет, гоняясь за багом, или добавили `debugPrint` внутри `packages/flutter`. Если эти правки нужны вам после обновления, отложите их в stash вместе с неотслеживаемыми файлами:

```bash
# Flutter 3.47.7 -> 3.47.8, verified 2026-10-29
git -C "$SDK" stash push -u -m "before flutter upgrade"
flutter upgrade
git -C "$SDK" stash pop
```

В моём воспроизведении обновление до 3.47.8 прошло чисто, а `stash pop` вернул и изменённый `text.dart`, и неотслеживаемый `notes.txt`. Если файлы, которые вы трогали, изменились в upstream между двумя версиями, `stash pop` может дать конфликт, и это честный результат: ваш патч писался под другую версию фреймворка.

Если у вас долгоживущие патчи к фреймворку, stash не подходит. Закоммитьте их в локальную ветку или, ещё лучше, ведите форк и подключайте к нему SDK конкретного проекта через менеджер версий, чтобы обновляемый SDK не совпадал с тем, который вы патчите.

### 2c. Ничего из лежащего там не важно: `--force`

Когда `git status --short` показывает только мусор, который вам не нужен, используйте force:

```bash
# Flutter 3.47.x, stable channel
flutter upgrade --force    # or: flutter upgrade -f
```

Нужно понимать, что делает `--force`, потому что это не то, что многие думают:

- Он пропускает проверку "Unknown flutter tag" и проверку локальных изменений. И всё.
- Затем он выполняет `git reset --hard <upstream revision>`. Отслеживаемые правки отбрасываются без резервной копии, а коммиты, сделанные вами в локальной ветке `stable`, пропадают из ветки и восстанавливаются только через `git reflog`.
- Он **не** удаляет неотслеживаемые файлы. В моём воспроизведении `notes.txt` пережил `--force` и после этого по-прежнему был виден в `git status`. Следующий запуск не заблокировался только потому, что сначала сработало "already up to date". При следующем релизе блокировка вернётся.

Чтобы окончательно убрать неотслеживаемые файлы, сначала посмотрите, что будет удалено, а затем удалите:

```bash
# Run inside the SDK folder; -n is a dry run
git -C "$SDK" clean -n -d
git -C "$SDK" clean -f -d
```

`git clean` удаляет файлы безвозвратно и учитывает `.gitignore`, поэтому `bin/cache/` и `.pub-cache/` он не тронет. Прочитайте вывод с `-n`, прежде чем запускать настоящую команду.

### 3. Как не допустить повторения

- Перейдите на Flutter 3.47.0 или новее, где есть исправление с рабочим каталогом для повторного входа.
- Никогда не запускайте `flutter upgrade` изнутри дерева SDK.
- Не храните в папке SDK черновые файлы, заметки или экспериментальные проекты. Создавайте приложения рядом с ней, а не внутри.
- В Windows не устанавливайте SDK распаковкой архива через "Извлечь всё" в Проводнике. Проводник не может создать некоторые глубокие пути в SDK (эталонные скриншоты сценарного приложения iOS превышают `MAX_PATH`), пропускает их, и эти недостающие отслеживаемые файлы показываются в `git status` как удалённые, что блокирует все последующие обновления ([issue #193197](https://github.com/flutter/flutter/issues/193197), отслеживается в [#183172](https://github.com/flutter/flutter/issues/183172)). Устанавливайте через `git clone`, предварительно включив длинные пути в Git (`core.longpaths`) и в Windows, как описано в [документации Flutter по обновлению](https://docs.flutter.dev/install/upgrade). Если у вас уже такая установка, то `git -C $sdk checkout -- .` после включения длинных путей вернёт недостающие файлы.

## Подводные камни и похожие ошибки

**"Unknown flutter tag. Abandoning upgrade to avoid destroying local changes."** Другая проверка, то же семейство. Срабатывает, когда `git describe` не находит тег релиза рядом с вашим коммитом, обычно после поверхностного клона без тегов или после перехода на произвольный коммит. В официальном канале сообщение советует использовать git напрямую, в остальных случаях предлагает `--force`. Перед force загрузите теги (`git -C "$SDK" fetch --tags`).

**"Your Flutter checkout is currently not on a release branch."** Вы находитесь в состоянии detached HEAD, обычно потому, что последовали совету из документации выполнить `git checkout <version>` для закрепления версии. Выполните `flutter channel stable`, чтобы вернуться на ветку, и затем обновляйтесь.

**"The current Flutter branch/channel is not tracking any remote repository."** У вашей локальной ветки нет upstream. Документированное решение это переустановка; также подойдёт `git -C "$SDK" branch -u origin/stable`, если `origin` является официальным удалённым репозиторием.

**Шум из-за режимов файлов или переводов строк.** Если `git diff` в SDK показывает только строки `old mode 100755` / `new mode 100644`, что-то (`chmod -R`, копирование между файловыми системами, синхронизируемая папка) изменило права доступа. Если в Windows каждый файл отображается как изменённый, чекаут скопировали с другими окончаниями строк. В обоих случаях ничего важного не изменилось; правильный выход это `git -C "$SDK" checkout -- .` или `--force`. В `.gitattributes` SDK используется `* text=auto`, поэтому свежий клон остаётся самым чистым выходом, если копия сильно испорчена.

**Ошибка появляется в CI.** Если образ CI кеширует SDK между запусками и предыдущее задание выполнило `flutter upgrade` на SDK 3.44.x (или изнутри дерева SDK), кешированный чекаут несёт изменённый lock-файл, и каждый последующий шаг обновления падает. Фиксируйте версию вместо обновления в CI; см. [как нацелиться на несколько версий Flutter из одного конвейера CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**`flutter upgrade` отработал, но ваш проект теперь не разрешает зависимости.** Это вторая половина запустила `pub upgrade` для вашего приложения с новыми закреплёнными версиями SDK, а не эта ошибка. Начните со статьи [исправление "version solving failed" в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Связанные материалы

- [Исправление: pubspec.lock показывается как изменённый после flutter upgrade или переключения версий Flutter](/ru/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) разбирает тот же дрейф в lock-файле вашего приложения, а не SDK.
- [Как нацелиться на несколько версий Flutter из одного конвейера CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) о закреплении SDK вместо обновления их на месте.
- [Исправление: "version solving failed" в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) о том, что может сломаться сразу после обновления.
- [Исправление: flutter doctor --android-licenses завершается ошибкой с cmdline-tools 23](/ru/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/), ещё одна ошибка инструментов, где решение зависит от используемого релиза Flutter.

## Источники

- [`upgrade.dart` в ветке stable](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/upgrade.dart), порядок проверок и вызов `git status -s`.
- [`findProjectRoot` в `os.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/base/os.dart), поиск pubspec.yaml вверх по дереву.
- [PR #188794: Run re-entrant upgrade in original CWD](https://github.com/flutter/flutter/pull/188794), вошёл в 3.47.0.
- [PR #184997: Ignore pubspec.lock dirty checkout modifications on non-stable channels](https://github.com/flutter/flutter/pull/184997), вошёл в 3.47.0.
- [Issue #187977](https://github.com/flutter/flutter/issues/187977) (дрейф `objective_c` в stable), [issue #178777](https://github.com/flutter/flutter/issues/178777) (дрейф в main), [issue #128635](https://github.com/flutter/flutter/issues/128635) (`.pub-cache` внутри SDK), [issue #193197](https://github.com/flutter/flutter/issues/193197) (распаковка через Проводник Windows).
- [Upgrading Flutter](https://docs.flutter.dev/install/upgrade) на docs.flutter.dev, включая раздел Windows про "Filename too long".

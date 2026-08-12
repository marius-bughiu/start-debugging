---
title: "Исправление: dotnet tool install --global dotnet-ef выдаёт ошибку"
description: "Все способы, которыми dotnet tool install --global dotnet-ef падает на SDK .NET 10, с точным сообщением и кодом возврата для каждого: уже установлен, версия не найдена, понижение версии заблокировано, конфликт shim, недоступный фид NuGet и несоответствие среды выполнения, которое ломается уже после успешной установки."
pubDate: 2026-08-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "ef-core"
  - "entity-framework"
lang: "ru"
translationOf: "2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error"
translatedBy: "claude"
translationDate: 2026-08-12
---

`dotnet tool install --global dotnet-ef` падает по шести разным причинам, и SDK выдаёт для каждой отдельное однострочное сообщение без трассировки стека, по которой их можно было бы различить. Читайте строку, а не код возврата: "Tool 'dotnet-ef' is already installed." завершается с кодом **0** и вообще не является ошибкой, тогда как "is not found in NuGet feeds", "is lower than existing version", "conflicts with an existing command from another tool" и "No NuGet sources are defined or enabled" завершаются с кодом **1**, и каждому нужен свой флаг. Всё описанное ниже выполнялось на SDK 10.0.201 под Windows 11 2026-08-12 против живого фида nuget.org.

## Ошибка в контексте

Это реальные сообщения, записанные дословно. SDK печатает одну строку и останавливается:

```
Tool 'dotnet-ef' is already installed.

Version 99.0.0 of package dotnet-ef is not found in NuGet feeds https://api.nuget.org/v3/index.json.

dotnet-ef-typo-xyz is not found in NuGet feeds https://api.nuget.org/v3/index.json.

The requested version 8.0.11 is lower than existing version 9.0.11.

Tool 'dotnet-ef' failed to update due to the following:
Failed to create shell shim for tool 'dotnet-ef': Command 'dotnet-ef' conflicts with an existing command from another tool.
Tool 'dotnet-ef' failed to install.

No NuGet sources are defined or enabled

Unhandled exception: Unable to load the service index for source https://nuget.invalid.example/v3/index.json.
```

Есть седьмой сбой, который хуже всех перечисленных, потому что установка сообщает об успехе:

```
You can invoke the tool using the following command: dotnet-ef
Tool 'dotnet-ef' (version '3.1.32') was successfully installed.
```

а затем инструмент отказывается запускаться.

## Почему это происходит

`dotnet tool install` выполняет три отдельные задачи в одной команде, и у каждой задачи своя область отказа. Он разрешает версию пакета из настроенных фидов NuGet, распаковывает этот пакет в хранилище инструментов и записывает исполняемый shim в каталог инструментов. Проблема разрешения NuGet, правило упорядочивания версий и коллизия имён в файловой системе порождают совершенно не связанные между собой сообщения, поэтому поиск по запросу "dotnet tool install dotnet-ef error" возвращает советы, не имеющие отношения к тому, что вы видите.

Седьмой случай отличается принципиально. Установка инструмента никогда не проверяет наличие среды выполнения, способной его запустить. Целевая платформа пакета проверяется хостом только при старте, поэтому инструмент, собранный под отсутствующую у вас среду выполнения, устанавливается без нареканий и умирает при первом же использовании.

## Repro: воспроизведение каждого сбоя на SDK 10.0.201

Во время экспериментов используйте `--tool-path`, а не `--global`. Это изолирует каждый случай в одноразовом каталоге вместо того, чтобы трогать ваше настоящее хранилище инструментов, а сообщения об ошибках при этом идентичны:

```bash
# SDK 10.0.201. Each block is one failure mode.
dotnet tool install --tool-path ./tp dotnet-ef --version 99.0.0
dotnet tool install --tool-path ./tp dotnet-ef-typo-xyz
dotnet tool install --tool-path ./tp dotnet-ef --version 9.0.11
dotnet tool install --tool-path ./tp dotnet-ef --version 8.0.11
```

Третья команда выполняется успешно, четвёртая печатает `The requested version 8.0.11 is lower than existing version 9.0.11.` и завершается с кодом 1. Чтобы воспроизвести коллизию shim, сначала положите в целевой каталог любой файл с именем команды инструмента:

```bash
# SDK 10.0.201
mkdir -p ./tp6 && echo dummy > ./tp6/dotnet-ef.exe
dotnet tool install --tool-path ./tp6 dotnet-ef
```

## Исправление, подробно

Отсортировано по тому, насколько часто вы реально сталкиваетесь с каждым случаем.

### "Tool 'dotnet-ef' is already installed." не является сбоем

Код возврата 0. Измерено, а не предположено. Команда идемпотентна по замыслу, поэтому оставлять её без защиты в скрипте подготовки окружения или в Dockerfile правильно, и сборку это не сломает.

Людей сбивает с толку то, что та же самая команда иногда печатает совсем другое:

```
Tool 'dotnet-ef' was successfully updated from version '10.0.10' to version '10.0.11'.
```

На SDK .NET 10 команда `dotnet tool install --global dotnet-ef` без `--version` обновляет существующую установку до последней стабильной версии, а не отказывается работать. Сообщение "already installed" вы получаете только тогда, когда версия, на которую вы бы перешли, уже установлена. Если вы хотели зафиксированную версию, а получили неожиданное обновление, причина в этом: зафиксируйте её.

```bash
# SDK 10.0.201. Both forms work; the @ syntax needs SDK 10.0.100 or later.
dotnet tool install --global dotnet-ef --version 10.0.11
dotnet tool install --global dotnet-ef@10.0.11
```

### "is not found in NuGet feeds" относится к версии, а не к пакету

Два разных сообщения используют одну и ту же формулировку и означают разное. `dotnet-ef-typo-xyz is not found in NuGet feeds ...` называет пакет, значит идентификатор пакета неверен или ваш фид его не содержит. `Version 99.0.0 of package dotnet-ef is not found in NuGet feeds ...` называет версию, значит пакет разрешился нормально, а версии не существовало.

Второй случай встречается чаще, потому что `--version 11.0.0` работает не так, как ожидают. Начиная с .NET 8 запись `--version Major.Minor.Patch` означает именно эту версию, включая неопубликованные в списке, и не плавает. Для самой свежей 11.x используйте подстановочный знак, а для предварительной версии нужно явно согласиться:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 11.0.*
dotnet tool install --global dotnet-ef --prerelease
```

Запуск с `--prerelease` разрешился в `11.0.0-preview.7.26381.103` в день написания статьи. Без флага предварительные версии невидимы, и вы получаете "not found" для версии, которая прекрасно видна на nuget.org.

### "The requested version X is lower than existing version Y"

Установка поверх более новой версии инструмента отклоняется, как и `dotnet tool update` на более старую версию. Флаг существует именно для этого:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 8.0.11 --allow-downgrade
```

Он сообщает `Tool 'dotnet-ef' was successfully updated from version '9.0.11' to version '8.0.11'.` и завершается с кодом 0. Используйте это, когда фиксируете инструмент под более старую среду выполнения EF Core в устаревшей ветке. Команда `dotnet tool uninstall --global dotnet-ef` с последующей чистой установкой тоже работает, но это две команды, и вы останетесь вообще без инструмента, если вторая упадёт.

### "Failed to create shell shim ... conflicts with an existing command from another tool"

В каталоге инструментов уже лежит исполняемый файл с именем `dotnet-ef`, который эта установка не создавала. Установка прерывается, а не затирает его, и обратите внимание на обманчивую первую строку: она говорит "failed to update" прежде, чем сказать "failed to install".

На практике это почти всегда наполовину удалённая предыдущая установка либо установка через `--tool-path`, перекрывающая установку через `--global`. Найдите устаревший shim и удалите его. Глобальные инструменты живут в `%USERPROFILE%\.dotnet\tools` на Windows и в `$HOME/.dotnet/tools` на Linux и macOS, а сами двоичные файлы находятся в соседнем каталоге `.store`:

```bash
# SDK 10.0.201
dotnet tool list --global
ls ~/.dotnet/tools
```

Если `dotnet tool list --global` не показывает `dotnet-ef`, а файл на месте, то shim осиротел и его безопасно удалить вручную.

### "No NuGet sources are defined or enabled"

Восстанавливать пакет неоткуда. В каком-то `NuGet.config` выше вашего текущего каталога в `<packageSources>` стоит `<clear />` и ничего не добавлено обратно, либо все источники отключены. В репозитории, ограниченном приватным фидом, на это легко наткнуться и легко не заметить, потому что мешающий файл конфигурации может лежать на несколько каталогов выше.

```bash
# SDK 10.0.201
dotnet nuget list source
dotnet tool install --global dotnet-ef --source https://api.nuget.org/v3/index.json
```

`--source` заменяет все настроенные источники в рамках одной этой команды, и это самый быстрый способ убедиться, что проблема в конфигурации, а не в сети.

### "Unable to load the service index for source"

Один из фидов в вашей конфигурации недоступен, и на SDK 10.0.201 это всплывает как голая строка `Unhandled exception:`. Она прерывает всю установку, даже если рабочий фид дальше по списку содержит нужный пакет. Скажите SDK считать недоступный фид предупреждением:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --ignore-failed-sources
```

С конфигурацией, где недоступный приватный фид идёт перед nuget.org, голая команда упала с исключением, а `--ignore-failed-sources` чисто установил 10.0.11. Если пакет лежит именно в приватном фиде, этот флаг не спасёт и вместо него понадобится `--interactive` для прохождения аутентификации.

### Установка проходит, а инструмент не запускается

Вот этот случай стоит целого дня. Установка старого `dotnet-ef` на машину без нужной ему среды выполнения проходит нормально, а затем:

```
You must install or update .NET to run this application.

App: ...\dotnet-ef.exe
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '3.1.0' (x64)
.NET location: C:\Program Files\dotnet\

The following frameworks were found:
  6.0.36 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  8.0.23 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  10.0.5 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
```

Исправление это флаг на этапе установки, доступный начиная с SDK .NET 9, который разрешает инструменту работать на более новой среде выполнения, чем целевая:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 3.1.32 --allow-roll-forward
```

Тот же пакет, та же машина. Без флага shim отказывается стартовать, с ним `dotnet-ef --version` печатает `3.1.32` на среде выполнения 10.0.5. Это решение времени установки, зашитое в shim, поэтому уже установленный инструмент придётся переустановить, чтобы оно применилось.

## Что изменилось в SDK .NET 10

Изменились три поведения, и все три порождают вопросы в поддержку.

Установка теперь работает как установить-или-обновить для глобальных инструментов без зафиксированной версии, поэтому команда, которая раньше ничего не делала на подготовленной машине, теперь молча продвигает вас на патч-версию вперёд. Зафиксируйте версию, если это важно.

Локальные установки больше не падают при отсутствии манифеста. Раньше `dotnet tool install dotnet-ef` без `-g` в папке без `.config/dotnet-tools.json` выдавала "Cannot find a manifest file." Начиная с .NET 10 параметр `--create-manifest-if-needed` включён по умолчанию, и манифест создаётся за вас в ближайшем родительском каталоге, содержащем подпапку `.git`. Обычно это правильно и изредка совсем неправильно: запустите команду из папки загрузок или изнутри чужого репозитория, и вы молча измените чужой манифест. Отключается это через `--create-manifest-if-needed=false`. Флаг `-d`, который раньше печатал просмотренные места поиска манифеста, мёртв, потому что ошибки, которую он пояснял, больше не существует.

Синтаксис `@version` появился в SDK 10.0.100, так что `dotnet-ef@10.0.11` теперь эквивалентно `dotnet-ef --version 10.0.11`. Смешивать обе формы нельзя: передача `dotnet-ef@10.0.11` вместе с `--version` возвращает "Cannot specify --version when the package argument already contains a version."

## Можно ли запустить dotnet-ef без установки

Если установка падает на CI-раннере, который вы не контролируете, самое быстрое решение в .NET 10 это вообще не устанавливать. Команда `dotnet tool exec` и её сокращение `dnx` скачивают и запускают инструмент за один заход:

```bash
# SDK 10.0.201
dnx dotnet-ef -y -- --version
dotnet tool exec dotnet-ef --yes -- database update
```

Флаг `-y` подтверждает запрос на скачивание, и он нужен в любом неинтерактивном контексте. Разделитель `--` здесь не опционален, а сбой без него сбивает с толку: `dnx` разбирает `--version`, `--prerelease` и `--source` как собственные опции, поэтому `dnx dotnet-ef --version` до инструмента никогда не доходит. Всё, что предназначено для `dotnet-ef`, ставьте после `--`.

Одноразовый запуск также учитывает локальный манифест. Если рядом есть `.config/dotnet-tools.json`, `dnx` запустит зафиксированную там версию вместо последней из фида, что делает его разумным вариантом по умолчанию для скриптов репозитория.

## Подводные камни и похожие ошибки

**"Could not execute because the specified command or file was not found"** это другая проблема. Установка прошла, а каталог shim отсутствует в вашем `PATH`. Разбор этого случая есть в отдельной статье про [исправление dotnet ef not found](/ru/2023/06/how-to-fix-command-dotnet-ef-not-found/); на Linux инструмент запускается только из `$HOME/.dotnet/tools`, пока вы сами не экспортируете путь, а на CI-раннере обычно сначала нужно [добавить сам dotnet в PATH](/ru/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

**Предупреждение о том, что инструменты старее среды выполнения**, отправляет людей переустанавливать, когда ничего не сломано:

```
The Entity Framework tools version '8.0.11' is older than that of the runtime '10.0.5'. Update the tools for the latest features and bug fixes. See https://aka.ms/AAc1fbw for more information.
```

Это предупреждение, а не причина того, что упало следом. В приведённом выше запуске за ним шла никак не связанная ошибка "No DbContext was found in assembly". Обновите инструмент, если хотите, но не считайте, что это что-то починило.

**Успешная установка не означает, что `dotnet ef` заработает в вашем решении.** Два самых частых следующих сбоя это неразрешимый хост времени разработки, разобранный в [Unable to create an object of type DbContext](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), и пакет design в неправильном проекте, разобранный в [стартовый проект не ссылается на Microsoft.EntityFrameworkCore.Design](/ru/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

**Не устанавливайте инструмент на продакшн-машины ради применения миграций.** Соберите migration bundle в CI: на целевой машине не понадобится ни SDK, ни глобальный инструмент. Этот процесс описан в статье [применение миграций EF Core 11 через dotnet ef migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Связанное

Как только инструмент установился, трение смещается на его корректный вызов в разделённом решении, и в EF Core 11 наконец появился ответ на это в виде [файла значений по умолчанию .config/dotnet-ef.json](/ru/2026/06/efcore-11-dotnet-ef-json-config-file/). Если вы попали сюда в разгар обновления, версия инструмента это один пункт из многих в [чеклисте перехода с .NET 8 на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) и в [ломающих изменениях с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Источники

- [Команда dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), справочник опций, таблица мест установки и правило сопоставления `--version Major.Minor.Patch`, введённое в .NET 8.
- [Ломающее изменение: dotnet tool install --local создаёт манифест по умолчанию](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/10.0/dotnet-tool-install-local-manifest), об убранной ошибке "Cannot find a manifest file." и об отказе через `--create-manifest-if-needed=false`.
- [Что нового в SDK и инструментах .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk), об одноразовом запуске через `dotnet tool exec` и о скрипте `dnx`.
- [Диагностика проблем с использованием инструментов .NET](https://learn.microsoft.com/en-us/dotnet/core/tools/troubleshoot-usage-issues), о диагностике PATH и shim.

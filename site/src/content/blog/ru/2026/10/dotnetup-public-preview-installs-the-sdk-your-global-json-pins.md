---
title: "dotnetup в публичной предварительной версии: одна команда устанавливает SDK, закреплённый в global.json"
description: "15 октября 2026 года dotnetup вышел в публичную предварительную версию. Запустите dotnetup sdk install в репозитории, и он прочитает global.json, сопоставит rollForward с каналом обновлений и даже сможет записывать в файл новые патч-версии."
pubDate: 2026-10-15
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
  - "global-json"
lang: "ru"
translationOf: "2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins"
translatedBy: "claude"
translationDate: 2026-10-15
---

15 октября 2026 года Microsoft [анонсировала публичную предварительную версию dotnetup](https://devblogs.microsoft.com/dotnet/introducing-dotnetup/), менеджера наборов инструментов для SDK и сред выполнения .NET в стиле rustup. Когда я [впервые писал о нём в июне](/ru/2026/06/dotnetup-official-dotnet-sdk-version-manager/), его приходилось собирать из исходников, и подтверждённой была только команда `dotnetup sdk install preview`. Теперь есть установщик в одну строку, полный [справочник команд на Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnetup/) и ответ на вопрос, который волновал меня больше всего: что он делает с `global.json`.

## Установка на машину

Скрипт начальной установки скачивает последнюю сборку `preview`, проверяет её контрольную сумму SHA-512 и помещает её в `~/.dotnetup`. Без `sudo`.

```bash
# macOS / Linux (x64 and Arm64, glibc and musl)
curl -fsSL https://aka.ms/dotnetup/get-dotnetup.sh | bash

# then, non-interactively
dotnetup install latest
dotnetup env set shell
```

В Windows аналогом служит команда PowerShell `irm https://aka.ms/dotnetup/get-dotnetup.ps1 | iex`. Будьте осторожны с настройками Windows по умолчанию. `dotnetup init` предлагает режим `everywhere`, который изменяет системный `PATH` и задаёт `DOTNET_ROOT`. После этого управляемая установка получает приоритет над SDK, установленными Visual Studio, поэтому проект, которому нужен общесистемный SDK, отсутствующий в dotnetup, перестанет собираться. Выбирайте `shell` или `none`, если не планируете переносить всё целиком.

Режим `none` самый интересный для знакомства. Он не трогает `PATH` и `DOTNET_ROOT`, а вместо этого перенаправляет команды:

```bash
dotnetup env set none --dotnetup-on-path true
dotnetup dotnet -- --info
dotnetup dotnet build
```

## global.json становится отслеживаемым требованием

Внутри репозитория запустите `dotnetup sdk install` без указания канала. Команда поднимается вверх от текущего каталога, использует ближайший `global.json`, а если его нет, переходит на `latest`. Некорректный файл приводит к ошибке команды. Она не переходит молча к родительскому каталогу.

```json
{
  "sdk": {
    "version": "10.0.103",
    "rollForward": "latestPatch"
  }
}
```

Ключевая деталь в том, что dotnetup не просто устанавливает `10.0.103`. Он превращает `rollForward` в канал, который `dotnetup update` будет постоянно обновлять:

| `rollForward` | Отслеживаемый канал |
| --- | --- |
| пропущен или `latestPatch` | `10.0.1xx` |
| `latestFeature` | `10.0` |
| `latestMinor` | `10` |
| `latestMajor` | `latest` |
| `disable`, `patch`, `feature`, `minor`, `major` | точная версия `10.0.103`, никогда не обновляется |

`allowPrerelease` на канал не влияет. `dotnetup list` показывает путь к `global.json` как источник каждого требования, так что видно, какой репозиторий удерживает старый SDK. Когда на SDK больше ничто не ссылается, следующее обновление его удаляет.

## Запись патчей обратно в global.json

Для меня это новинка, и она очень удобна для репозиториев, закрепляющих точные патч-версии ради воспроизводимых сборок:

```bash
dotnetup sdk install --update-global-json
# later, across every tracked repo
dotnetup sdk update --update-global-json
```

Команда устанавливает самый новый SDK в выведенном канале и переписывает только `sdk.version`, сохраняя форматирование, остальные свойства и кодировку текста файла. Это заменяет PR в стиле Dependabot или ручную правку каждый Patch Tuesday.

## Шероховатости предварительной версии

- Если в `global.json` есть `sdk.paths`, dotnetup устанавливает SDK по первому элементу. В этой предварительной версии он воспринимает `$host$` как буквальный путь и не пропускает пустые элементы, поэтому не указывайте `sdk.paths` или передайте `--install-path`.
- `dotnetup sdk uninstall 10.0.1xx --source globaljson` удаляет все подходящие требования из `global.json` в корне установки, а не только требование текущего репозитория.
- Полноценная интеграция с GitHub Actions и Azure DevOps пока в планах, хотя команды уже работают в CI без взаимодействия с пользователем.

Если вы работаете с несколькими репозиториями, закреплёнными на разных диапазонах функциональных версий .NET 10, то `dotnetup sdk install` для каждого репозитория плюс еженедельный `dotnetup update` уже лучше, чем скрипты `dotnet-install`. Отзывы принимаются в [обсуждениях dotnetup в dotnet/sdk](https://github.com/dotnet/sdk/discussions/categories/dotnetup).

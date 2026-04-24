---
title: ".NET 10 на Ubuntu 26.04: resolute-теги контейнеров и Native AOT в archive"
description: "Ubuntu 26.04 Resolute Raccoon поставляется с .NET 10 в archive, вводит теги контейнеров -resolute вместо -noble и упаковывает инструментарий Native AOT через dotnet-sdk-aot-10.0."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-10"
  - "ubuntu"
  - "containers"
  - "native-aot"
  - "linux"
lang: "ru"
translationOf: "2026/04/dotnet-10-ubuntu-2604-resolute-container-tags"
translatedBy: "claude"
translationDate: 2026-04-24
---

Ubuntu 26.04 "Resolute Raccoon" вышел в общую доступность 23 апреля 2026 года, и команда Microsoft .NET опубликовала сопутствующий блогпост в тот же день. Заголовок: .NET 10 лежит в archive дистрибутива с первого дня, нейминг тегов контейнеров изменился, и у Native AOT наконец-то появился нормальный apt-пакет. Если вы крутите .NET на Linux, это тот релиз, который меняет вид ваших `FROM`-строк на ближайшие два года.

## Resolute заменяет noble в тегах контейнеров

Начиная с .NET 10 стандартные теги контейнеров ссылаются на образы Ubuntu, а не Debian. С выходом 26.04 Microsoft добавила новый вариант на базе Ubuntu 26.04 под тегом `resolute`. Миграция механическая:

```dockerfile
# Before
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble

# After
FROM mcr.microsoft.com/dotnet/aspnet:10.0-resolute
```

Образы `noble` по-прежнему существуют и продолжают получать обновления базы 24.04, так что принудительной отсечки нет. Варианты `chiseled` двигаются синхронно: `10.0-resolute-chiseled` публикуется вместе с полным образом. Если вы уже на chiseled noble образах для distroless-style деплойментов, апгрейд - это замена тега и rebuild.

## Установка .NET 10 из archive

На 26.04 feed пакетов Microsoft не нужен. Archive Ubuntu несёт SDK напрямую:

```bash
sudo apt update
sudo apt install dotnet-sdk-10.0
```

.NET 10 - это LTS, так что версия из archive получает security servicing через Ubuntu до end-of-life дистрибутива. Это важно для укреплённых окружений, которые блокируют сторонние apt-источники.

## Native AOT как first-class apt-пакет

Это тихое, но важное изменение. До 26.04 сборка Native AOT на Ubuntu означала установить `clang`, `zlib1g-dev` и правильные куски toolchain самостоятельно. Archive 26.04 теперь поставляет `dotnet-sdk-aot-10.0`, который тянет за собой части линкера, которые target `PublishAot` из SDK ожидает.

```bash
sudo apt install -y dotnet-sdk-aot-10.0 clang
dotnet publish -c Release -r linux-x64
```

Microsoft называет бинарник 1.4 MB для hello-world приложения с cold start 3 мс и self-contained бинарник 13 MB для минимального веб-сервиса. Цифры размера и запуска знакомы всем, кто пользовался AOT с .NET 8, но то, что они выпадают из единственного `apt install` на стоковом LTS - это ново.

## .NET 8 и 9 через dotnet-backports

Если вы пока не готовы пересобирать на 10, PPA `dotnet-backports` - поддерживаемый путь для более старых всё ещё поддерживаемых версий на 26.04:

```bash
sudo apt install -y software-properties-common
sudo add-apt-repository ppa:dotnet/backports
sudo apt install dotnet-sdk-9.0
```

Microsoft называет это best-effort поддержкой, так что относитесь к этому как к мосту, а не долгосрочному плану. То, что Ubuntu 26.04 имел .NET 10 готовым в день выпуска, взялось из запуска CI `dotnet/runtime` против Ubuntu 26.04 с конца 2025. Если хотите проследить механику, [официальный блогпост .NET](https://devblogs.microsoft.com/dotnet/whats-new-for-dotnet-in-ubuntu-2604/) содержит полную историю.

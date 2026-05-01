---
title: "dotnet workload clean"
description: "Используйте команду `dotnet workload clean`, чтобы удалить оставшиеся .NET workload-паки после обновления SDK или Visual Studio: когда применять, что удаляется и подводные камни."
pubDate: 2023-09-04
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/dotnet-workload-clean"
translatedBy: "claude"
translationDate: 2026-05-01
---
Примечание: эта команда доступна только начиная с .NET 8.

Она очищает workload-паки, которые могут остаться после обновления .NET SDK или Visual Studio. Это полезно, когда вы сталкиваетесь с проблемами при управлении workloads.

`dotnet workload clean` удалит «осиротевшие» паки, оставшиеся после деинсталляции .NET SDK. Команда не трогает workloads, установленные Visual Studio, но выдаёт список workloads, которые вам стоит почистить вручную.

Dotnet workloads находятся по пути: `{DOTNET ROOT}/metadata/workloads/installedpacks/v1/{pack-id}/{pack-version}/`. Файл `{sdk-band}` в папке записи об установке выполняет роль счётчика ссылок: если в папке workload нет файла sdk-band, значит, пакет workload не используется и его можно безопасно удалить с диска.

## dotnet workload clean --all

В конфигурации по умолчанию команда удаляет только осиротевшие workloads, но если передать аргумент `--all`, мы говорим ей очистить все паки на машине, кроме тех, что установлены Visual Studio. Также будут удалены все записи об установке workloads.

---
title: "Миграция с .NET 8 на .NET 11: полный чек-лист"
description: "План миграции .NET 8: актуальный статус .NET 11 RC3, точный SDK, проверка совместимости, развёртывание и откат."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "ru"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Исправление — 2 ноября 2026 года:** .NET 11 ошибочно назывался уже выпущенной LTS-версией. Также исправлены выбор SDK, пакеты, хостинг, сериализация, запросы EF, блокировки и откат. Прежние утверждения о результатах миграций не подтверждались записанными тестами.

Поддержка .NET 8 заканчивается **10 ноября 2026 года**. [Текущая политика](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) указывает .NET 10 как LTS, а .NET 11 RC3 — как предварительный go-live-выпуск. .NET 11 относится к STS. Для уже выпущенного LTS рассмотрите .NET 10; если необходим .NET 11, явно учтите его статус и запланируйте очередное обновление. Обновление SDK само по себе не обновляет развёрнутые приложения.

## 1. Зафиксируйте исходное состояние и выберите SDK

Запишите runtime сервера, SDK сборки, ОС, зависимости, результаты тестов и характерное поведение приложения. Успешные исходные тесты помогают искать регрессии, но не доказывают, что любой последующий сбой вызван миграцией.

```bash
dotnet --info
dotnet --list-sdks
dotnet --version
dotnet list package --include-transitive
dotnet test -c Release
```

Выполняйте команды из каталога решения с выбранным SDK. [Выбор SDK](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) независим от целевой платформы. Для оценки полной версии RC3 со [страницы загрузки](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) используйте такой `global.json`:

```json
{
  "sdk": {
    "version": "11.0.100-rc.3.26522.148",
    "rollForward": "disable",
    "allowPrerelease": true
  }
}
```

`disable` требует именно этот SDK; `latestFeature` разрешает более поздние feature bands. Установите выбранный SDK также на CI. Номер RC3 проверен по опубликованным метаданным, но этот SDK не устанавливался и не запускался для статьи. Обновляйте pin осознанно при смене выпуска.

## 2. Измените целевую платформу и проверьте зависимости

Минимальная структура веб-проекта:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Это определение проекта .NET 11, а не проверенная здесь сборка .NET 11. Оставьте языковую версию по умолчанию SDK/TFM, если нет причины фиксировать её. C# 14 относится к .NET 10, а не является новым языком .NET 11.

**Не обновляйте все пакеты `Microsoft.*` до версии 11.** У продуктов независимые версии. Проверяйте целевые платформы, зависимости, совместимость провайдера и статус выпуска. Согласуйте EF Core, провайдер, Design-пакет и инструменты по их документации. При централизованном управлении проверьте `Directory.Packages.props`. Пакет `net8.0` может остаться совместимым; NuGet не предпочитает автоматически старый .NET Standard asset только потому, что цель новее.

## 3. Прочитайте изменения всех промежуточных версий

Проверьте списки [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/compatibility/9.0), [.NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10.0), [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11) и примечания используемых платформ/провайдеров. Список .NET 11 прямо обозначен как незавершённый.

- **BinaryFormatter:** Начиная с .NET 9 встроенная реализация выбрасывает исключение; типы API остаются. Предпочтите другой формат. [Руководство](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) также описывает чтение NRBF без создания произвольных сериализованных типов. Конвертация не обязательно требует старого приложения на .NET 8.
- **Хостинг:** `WebHostBuilder`, `IWebHost` и `WebHost` [объявлены устаревшими в .NET 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/webhostbuilder-deprecated?view=aspnetcore-10.0). Это не доказательство удаления всего кода с `IWebHostBuilder` или `ConfigureWebHostDefaults`. Для нового кода предпочтителен `WebApplication.CreateBuilder`; исправляйте фактические диагностики.
- **Запросы EF:** Для SQL Server EF8 ввёл JSON-параметры коллекций; [EF10 по умолчанию использует скалярные параметры](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection). Проверяйте SQL и планы на настоящем провайдере. Бездумное добавление `ToList()` может перенести работу в память; это не универсальное исправление.
- **Сериализация и компиляция:** Проверяйте реальные JSON-контракты, даты, числа, enum и полиморфизм. Разбирайте конкретные ошибки, включая преобразования span, вместо предположения, что любая span-перегрузка побеждает массив.
- **Блокировки:** `System.Threading.Lock` и Monitor допускают повторный вход. Статически типизированный `Lock` использует другой механизм, чем ссылка, приведённая к `object`; не смешивайте их для одного состояния. Замена блокировок не обязательна для смены платформы.
- **Хостинговые службы:** У Azure Functions собственная [матрица поддержки](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide#supported-versions). При этой проверке максимальная цель isolated worker — .NET 10; поддержка in-process заканчивается 10 ноября 2026 года. Наличие SDK не доказывает поддержку .NET 11.

## 4. Проверьте развёртываемый артефакт

Этот полный `Program.cs` предоставляет небольшой smoke-эндпоинт. Он не настраивает производственную аутентификацию, контроллеры или базу:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

Пример успешно собран, опубликован и вызван на .NET 8.0.33 и 10.0.10. `--self-contained false` требует совместимого runtime на хосте. Для автономного развёртывания выберите настоящий RID и `--self-contained true`; проверяйте артефакт на целевой ОС. `/health` не появляется автоматически в любом проекте.

В staging также проверьте аутентификацию, авторизацию, контракты чтения/записи, транзакции, фоновые задачи и откат. Измеряйте согласованную нагрузку. При trimming/AOT устраняйте реальные предупреждения и запускайте опубликованный результат; аннотации не делают произвольную генерацию кода во время выполнения совместимой с Native AOT.

## 5. Сохраните возможность совместимого отката

Сохраните прежний артефакт и конфигурацию. Схема, сохранённые данные, сообщения и состояние аутентификации определяют возможность совместной работы версий. Первая запись не делает откат автоматически невозможным, а смена SDK не создаёт миграцию базы. Применяйте совместимые изменения и заранее репетируйте возврат трафика.

**Границы проверки:** Миграция .NET 11, обновление EF/базы, развёртывание Azure и сравнение производительности не выполнялись. Переносимый пример и отдельные исправления проверены на .NET 8/10; сведения о версиях сверены с первичной документацией.

## Дополнительные первичные источники

- [System.Threading.Lock](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# 14 span overload resolution](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)

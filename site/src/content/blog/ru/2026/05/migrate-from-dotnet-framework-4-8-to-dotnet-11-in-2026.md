---
title: "Миграция с .NET Framework 4.8 на .NET 11 в 2026 году"
description: "Миграция .NET Framework 4.8: актуальная поддержка, постепенный перенос ASP.NET, зависимости, конфигурация и откат."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "ru"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Исправление — 2 ноября 2026 года:** Исправлены статус .NET 11, поддержка Framework, конфигурация, сериализация, инструменты и развёртывание. Удалены неподтверждённые сроки, экономия памяти и утверждения о якобы лично обнаруженных проблемах.

Переход с .NET Framework 4.8 на современный .NET может потребовать нового хоста и изменений библиотек, развёртывания и контрактов данных. Это не обновление runtime на месте. Сначала определите цель и часть приложения, которую можно перенести независимо.

На дату проверки [.NET 11 RC3 — предварительный go-live-выпуск](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), .NET 11 относится к STS, а .NET 10 — опубликованный LTS. [Поддержка Framework следует жизненному циклу Windows](https://learn.microsoft.com/en-us/lifecycle/faq/dotnet-framework); единой даты окончания Framework 4.8 для всех установок Windows 10 нет. Проверьте конкретную ОС и поддерживаемую ею версию Framework.

## Инвентаризация до изменения проектов

Соберите и протестируйте приложение в поддерживаемой Windows-среде. Сохраните developer/reference packs и инструменты сборки на время миграции. Зафиксируйте аутентификацию, сессии, интеграции Windows, нативные библиотеки, задания, провайдеры базы и сохранённые форматы. Совместимость определяется API и assets, а не правилом, запрещающим все библиотеки `net48`.

[Обзор Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) теперь помечает инструмент устаревшим и рекомендует агент модернизации GitHub Copilot. Автоматизация необязательна; проверяйте её изменения. Старый неприкреплённый к версии установочный вызов не гарантирует поддержку .NET 11.

По возможности отделите обновление формата проекта от смены runtime. SDK-style не преобразует `System.Web`, WCF-хостинг, COM и пользовательские MSBuild-задачи. Сохраняйте рабочую базовую версию и переносите конечные библиотеки раньше вызывающего кода.

## Выберите границу миграции

| Существующая зависимость | Планируемая работа |
| --- | --- |
| ASP.NET MVC 5 / Web API 2 | Адаптация маршрутов, фильтров, binding, аутентификации, сессий и хостинга |
| Web Forms / System.Web | Сохранить за границей постепенной миграции или заменить UI; ASP.NET Core не выполняет Web Forms |
| Сервер WCF | Проверить CoreWCF для реальных bindings/функций или изменить контракт |
| Клиент WCF | Проверить текущие пакеты System.ServiceModel и требования безопасности |
| EF6 | Проверить современный runtime/провайдер; EF Core планировать отдельно |
| WPF / WinForms | Windows-цели, проверка контролов, COM, нативных компонентов и установки |
| Дополнительные AppDomains / Remoting / CAS | Перепроектировать загрузку, обмен данными и изоляцию |

[Руководство ASP.NET](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/?view=aspnetcore-10.0) поддерживает постепенную миграцию. Прокси перед маршрутами позволяет сохранить старое приложение работающим. Частичный перенос допустим при осознанном управлении аутентификацией, маршрутами, владением данными и откатом.

[CoreWCF](https://github.com/CoreWCF/CoreWCF) не гарантирует идентичности всех функций и сетевых контрактов WCF. Тестируйте используемые bindings и аутентификацию. [EF6 поддерживает современный .NET с версии 6.3](https://learn.microsoft.com/en-us/ef/ef6/what-is-new/); выбирайте и проверяйте актуальную совместимую версию/провайдер, а не объявляйте 6.5.0 универсальным минимумом. EF Core не является прямой заменой EF6.

## Начните с небольшого рабочего фрагмента

Базовый проект ASP.NET Core для оценки .NET 11:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Используйте установленный и явно выбранный SDK с совместимыми пакетами. [Чек-лист перехода с .NET 8 на 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) показывает текущий pin RC3. Настольному проекту нужны Windows-TFM и соответствующие настройки; не заменяйте каждый проект на `Microsoft.NET.Sdk.Web`.

Этот полный `Program.cs` — smoke-тест, а не перенесённое приложение:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

Он собран, опубликован и вызван на .NET 8 и 10 в ходе исправления. MVC-приложение должно зарегистрировать контроллеры перед отображением маршрутов. Аутентификация требует настоящей схемы и служб; один `UseAuthentication()` не переносит Forms Authentication.

## Сохраните семантику конфигурации и данных

Небольшой `appsettings.json`:

```json
{
  "Migration": {
    "MaxRetries": 3
  }
}
```

[JSON-провайдер конфигурации нечувствителен к регистру ключей](https://learn.microsoft.com/en-us/dotnet/core/extensions/configuration-providers). Это не правило для произвольной JSON-сериализации. Проверьте приоритет провайдеров и хранение секретов. XML-провайдер не воспроизводит автоматически все секции `app.config` или binding redirects. `System.Configuration.ConfigurationManager` может сохранить совместимость поддерживаемых API; удалять все его вызовы необязательно. При IIS файл `web.config` остаётся важным.

Встроенная реализация `BinaryFormatter` выбрасывает исключение начиная с .NET 9, но тип сохраняется. Выберите другой сериализатор или оцените [NRBF reader](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) для извлечения данных без создания произвольных закодированных типов. Конвертация не обязательно требует старого небезопасного десериализатора на Framework 4.8.

`AssemblyLoadContext` обеспечивает загрузку и кооперативную выгрузку сборок, но не восстанавливает границу безопасности AppDomain. Ссылки, выполняемый код и обработчики событий могут мешать выгрузке. Один запуск GC не доказывает успех. Для недоверенного кода нужна подходящая граница процесса/контейнера и разрешения.

Не отключайте проверку сертификатов. При ошибках TLS исследуйте сертификат, имя хоста, цепочку доверия, настройки SQL-клиента и платформу. Не принимайте все сертификаты как обходной путь. Проверяйте конкретные форматы/культуры дат и контракты вместо предположения об общем изменении парсинга в .NET 11.

## Развёртывание и репетиция отката

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

Команда явно публикует framework-dependent приложение. Автономная поставка требует `--self-contained true` и подходящего RID; это не автоматическое следствие `dotnet publish`. Сохраните Windows CI для оставшихся Framework-проектов и проверяйте новый артефакт на реальной целевой платформе.

Проверяйте отказ в доступе, а не только успешные запросы, сессии, записи в базу, сообщения, фоновые задачи и desktop-интеграции. Держите старое развёртывание доступным, применяйте совместимые изменения и репетируйте возврат трафика. Для отката нужны старая программа и конфигурация, а не только повторная установка Framework.

**Границы проверки:** Здесь не тестировались Windows/Framework-приложение, SDK .NET 11, WCF-служба, миграция EF и производственное развёртывание. Переносимый эндпоинт и JSON-ключи проверены на .NET 8 и 10. Оценивайте трудозатраты и производительность на собственном представительном фрагменте приложения.

## Дополнительные первичные источники

- [AssemblyLoadContext](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext)
- [.NET Framework technologies unavailable on .NET](https://learn.microsoft.com/en-us/dotnet/core/porting/net-framework-tech-unavailable)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)

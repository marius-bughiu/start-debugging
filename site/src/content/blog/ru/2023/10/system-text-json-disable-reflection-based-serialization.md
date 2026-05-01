---
title: "System.Text.Json отключаем сериализацию на основе рефлексии"
description: "Узнайте, как, начиная с .NET 8, отключить сериализацию на основе рефлексии в System.Text.Json для trimmed- и native AOT-приложений с помощью свойства JsonSerializerIsReflectionEnabledByDefault."
pubDate: 2023-10-21
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8 вы можете отключить дефолтный сериализатор `System.Text.Json` на основе рефлексии. Это бывает полезно в trimmed- и native AOT-приложениях, в сборку которых вы не хотите тянуть компоненты рефлексии.

Включить эту функциональность можно, выставив свойство `JsonSerializerIsReflectionEnabledByDefault` в `false` в своём `.csproj`-файле.

```xml
<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
```

Побочный эффект: при сериализации и десериализации вам придётся передавать `JsonSerializerOptions`. В противном случае во время выполнения возникнет `NotSupportedException`.

Помимо этой опции, у `JsonSerializer` появилось новое свойство `IsReflectionEnabledByDefault`, которое позволяет разработчикам во время выполнения проверить, включена ли эта возможность.

---
title: "C# Как помечать функциональность как экспериментальную"
description: "Начиная с C# 12, новый ExperimentalAttribute позволяет помечать типы, методы, свойства или сборки как экспериментальные. Узнайте, как использовать его с diagnosticId, pragma-тегами и UrlFormat."
pubDate: 2023-10-29
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/experimental-features"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с C# 12 добавлен новый атрибут `ExperimentalAttribute`, который позволяет помечать типы, методы, свойства или сборки как экспериментальные возможности. При использовании это будет вызывать предупреждение компилятора, которое можно подавить с помощью тега `#pragma`.

Атрибут `Experimental` требует, чтобы в конструктор передавался параметр `diagnosticId`. Этот идентификатор диагностики станет частью сообщения компилятора, которое генерируется при каждом использовании экспериментальной возможности. Замечание: при желании вы можете использовать один и тот же diagnostic-id в нескольких атрибутах.

**Важно отметить:** не используйте в `diagnosticId` дефисы (`-`) или другие специальные символы, так как это может сломать синтаксис `#pragma` и не позволит пользователям отключить предупреждение. Например, использование `BAR-001` в качестве diagnostic id не позволит подавить предупреждение и вызовет предупреждение компилятора в самом pragma-теге.

> CS1696 Single-line comment or end-of-line expected.

[![](/wp-content/uploads/2023/10/image-3.png)](/wp-content/uploads/2023/10/image-3.png)

В атрибуте также можно указать `UrlFormat`, чтобы направить разработчиков к документации, связанной с экспериментальной функциональностью. Можно указать абсолютный URL, например `https://acme.com/warnings/BAR001`, или универсальный URL с подстановкой (`https://acme.com/warnings/{0}`) и позволить фреймворку сделать остальное.

Посмотрим на примеры.

## Помечаем метод как экспериментальный

```cs
using System.Diagnostics.CodeAnalysis;

[Experimental("BAR001")]
void Foo() { }
```

Вы просто помечаете метод атрибутом `Experimental` и передаёте ему `diagnosticId`. При вызове `Foo()` будет сгенерировано следующее предупреждение компилятора:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.

Это предупреждение можно обойти с помощью pragma-тегов:

```cs
#pragma warning disable BAR001
Foo();
#pragma warning restore BAR001
```

## Указание ссылки на документацию

Как упоминалось выше, ссылку на документацию можно задать через свойство `UrlFormat` атрибута. Это полностью необязательно.

```cs
[Experimental("BAR001", UrlFormat = "https://acme.com/warnings/{0}")]
void Foo() { }
```

После этого клик по кодам ошибок в Visual Studio будет открывать указанную страницу документации. Кроме того, URL добавится и в само сообщение об ошибке:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed. (https://acme.com/warnings/BAR001)

## Другие места применения

Атрибут можно применять практически где угодно: к сборкам, модулям, классам, структурам, перечислениям, свойствам, полям, событиям и так далее. Полный список разрешённых мест применения можно увидеть в самом определении:

```cs
[AttributeUsage(AttributeTargets.Assembly |
                AttributeTargets.Module |
                AttributeTargets.Class |
                AttributeTargets.Struct |
                AttributeTargets.Enum |
                AttributeTargets.Constructor |
                AttributeTargets.Method |
                AttributeTargets.Property |
                AttributeTargets.Field |
                AttributeTargets.Event |
                AttributeTargets.Interface |
                AttributeTargets.Delegate, Inherited = false)]
public sealed class ExperimentalAttribute : Attribute { ... }
```

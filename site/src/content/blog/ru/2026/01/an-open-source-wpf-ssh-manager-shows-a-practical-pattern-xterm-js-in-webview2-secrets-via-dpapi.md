---
title: "Open-source SSH-менеджер на WPF показывает практичный шаблон: xterm.js в WebView2, секреты через DPAPI"
description: "SshManager - это open-source SSH-менеджер на WPF, построенный на .NET 8. Он показывает практичный шаблон: xterm.js внутри WebView2 для отрисовки терминала, EF Core + SQLite для хранения и DPAPI для защиты локальных учётных данных."
pubDate: 2026-01-18
tags:
  - "dotnet"
  - "dotnet-8"
  - "webview2"
  - "wpf"
lang: "ru"
translationOf: "2026/01/an-open-source-wpf-ssh-manager-shows-a-practical-pattern-xterm-js-in-webview2-secrets-via-dpapi"
translatedBy: "claude"
translationDate: 2026-04-29
---
Сегодня на r/csharp всплыл интересный проект для Windows-десктопа: **SshManager** - open-source SSH- и serial-менеджер, собранный на **.NET 8** и **WPF**.

Источник: оригинальный пост на Reddit и репозиторий: [тред r/csharp](https://www.reddit.com/r/csharp/comments/1qgf6e1/i_built_an_opensource_ssh_manager_for_windows/) и [tomertec/sshmanager](https://github.com/tomertec/sshmanager).

## Интересна не "реализация SSH на C#"

Сам SSH давно решён. Интересно изучить, как это приложение сшивает три весьма прагматичные части:

-   **Реальный терминальный UI**: xterm.js, отрисовываемый внутри **WebView2** - так вы получаете терминальный UX (копирование, выделение, моноширинный рендеринг), не пытаясь изобретать терминальный контрол на WPF.
-   **Локальное хранение**: EF Core + SQLite для профилей соединений, тегов и метаданных сессий.
-   **Windows-нативная защита секретов**: пароли шифруются с помощью **Windows DPAPI**, ровно то, что нужно для локального десктоп-инструмента.

Этот шаблон мне нравится потому, что он оставляет "сложную UX-проблему" (отрисовку терминала) внутри проверенного веб-компонента, а остальное остаётся идиоматическим .NET 8.

## DPAPI - хороший дефолт для локальных учётных данных

DPAPI - это не межмашинное шифрование. Оно привязано к текущему профилю пользователя Windows (или к машине, в зависимости от scope). Для однопользовательского десктоп-приложения это плюс.

Вот минимальный helper "защитить/расшифровать", который можно перенести в WPF-приложение на .NET 8:

```cs
using System.Security.Cryptography;
using System.Text;

static class Dpapi
{
    public static string ProtectToBase64(string plaintext)
    {
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        var protectedBytes = ProtectedData.Protect(
            bytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedBytes);
    }

    public static string UnprotectFromBase64(string base64)
    {
        var protectedBytes = Convert.FromBase64String(base64);
        var bytes = ProtectedData.Unprotect(
            protectedBytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes);
    }
}
```

Если позже вы добавите "синхронизацию настроек между устройствами", DPAPI перестанет подходить, и вам понадобится другая стратегия ключей. Для Windows-first, чисто локального менеджера DPAPI - это ровно нужный уровень "скуки".

## WebView2 + xterm.js - это вариант "перестать бороться с WPF" для терминалов

Если вы строите внутренние инструменты на .NET 8, а UI должен вести себя как реальный терминал (vim, tmux, htop), встраивание xterm.js в WebView2 - удивительно чистая граница:

-   WPF владеет окном и жизненным циклом приложения.
-   Веб-сторона владеет отрисовкой терминала и поведением клавиатуры.
-   Ваш мост - это просто сообщения: записать байты в PTY, прочитать вывод, передать обратно.

Если хотите пример, не являющийся игрушечным демо, этот репозиторий стоит пробежать. Начните с модели соединения и того, как подключена вью терминала, и решите, подходит ли этот гибридный подход для вашего собственного инструментария.

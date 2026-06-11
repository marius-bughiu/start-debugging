---
title: "Статические SSR-формы Blazor получают валидацию на стороне клиента в .NET 11 Preview 5"
description: "Статически рендеримые на сервере формы Blazor могли валидироваться только после полного POST-цикла. .NET 11 Preview 5 рендерит метаданные валидации, чтобы JS Blazor применял правила DataAnnotations в браузере, без circuit."
pubDate: 2026-06-11
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "ru"
translationOf: "2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-11
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) вышел 2026-06-09, и одно изменение в ASP.NET Core закрывает пробел, который раздражал каждого, кто строит формы на статическом серверном рендеринге (static SSR): формы теперь валидируются в браузере без интерактивного режима рендеринга. До этой предварительной версии у формы static SSR был ровно один способ сообщить пользователю, что его адрес электронной почты составлен неверно: отправить всё целиком, дать серверу выполнить `DataAnnotations` и заново отрендерить страницу с сообщениями об ошибках. Это полный POST-цикл из-за опечатки.

## Почему формы static SSR были привязаны к серверу

Шаблон Blazor Web App рендерит большую часть контента как статический HTML. Здесь нет circuit SignalR и нет нагрузки WebAssembly, именно поэтому static SSR дёшев и быстр. Но валидация на стороне клиента требует кода, выполняющегося в браузере, а статическая страница не отправляет клиенту никакой логики компонента. Поэтому валидация целиком жила на сервере: вы отправляли форму, `DataAnnotationsValidator` обходил модель, и любые сбои возвращались как заново отрендеренная страница. Корректно, но медленно, и это плохой опыт по сравнению с интерактивной формой, которая отмечает неверное поле при потере фокуса.

Обычный обходной путь состоял в том, чтобы перевести компонент формы на `InteractiveServer` или `InteractiveWebAssembly` только ради живой обратной связи, платя за circuit или загрузку WASM, которые иначе вам не нужны.

## Как Preview 5 закрывает пробел

В Preview 5 сервер рендерит правила валидации как метаданные внутри HTML, а JS Blazor применяет их в браузере. Ваши атрибуты `DataAnnotations` остаются авторитетным источником истины, повторно вычисляемым на сервере при отправке. Браузер лишь получает раннюю бесплатную копию тех же правил. Эта возможность включена по умолчанию для каждой формы static SSR, которая содержит `DataAnnotationsValidator`, и работает как с улучшенными, так и с неулучшенными формами.

Никакого нового API изучать не нужно. Форма, которую вы уже написали, начинает валидироваться на стороне клиента, как только вы нацеливаетесь на SDK Preview 5:

```razor
<EditForm Model="Model" Enhance FormName="registration" OnValidSubmit="HandleValidSubmit">
    <DataAnnotationsValidator />
    <div>
        <label for="Email">Email</label>
        <InputText @bind-Value="Model!.Email" id="Email" />
        <ValidationMessage For="@(() => Model!.Email)" />
    </div>
    <button type="submit" id="submit-btn">Register</button>
</EditForm>
```

```csharp
public class RegistrationModel
{
    [Required]
    [EmailAddress]
    public string Email { get; set; }

    [Required]
    [StringLength(100, MinimumLength = 8)]
    public string Password { get; set; }

    [Required]
    [Compare("Password")]
    [Display(Name = "Confirm Password")]
    public string ConfirmPassword { get; set; }
}
```

Неверный адрес электронной почты или слишком короткий пароль теперь всплывает в браузере ещё до того, как форма попадёт в сеть. Сервер по-прежнему выполняет те же проверки при POST, так что вы не теряете эшелонированную защиту: клиентская валидация - это слой удобства, а не граница безопасности, ровно как и должно быть.

## Чего пока не хватает

Асинхронные правила (проверка уникальности в базе данных, запрос к удалённому API) пока сюда не входят. В примечаниях к выпуску сказано, что полная асинхронная история появится, когда новые асинхронные API `DataAnnotations` выйдут в одной из последующих предварительных версий. Пока это покрывает синхронный набор атрибутов, который составляет основную массу реальной валидации форм.

Это сочетается с другими дополнениями Preview 5, такими как [сериализация JSON Lines в System.Text.Json](/ru/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/). Чтобы попробовать, установите SDK .NET 11 Preview 5 и нацельтесь на `net11.0`. Все подробности - в [примечаниях к выпуску ASP.NET Core Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md).

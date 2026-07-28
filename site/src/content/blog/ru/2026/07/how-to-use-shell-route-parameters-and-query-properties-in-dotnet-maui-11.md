---
title: "Как использовать параметры маршрутов Shell и query properties для навигации в .NET MAUI 11"
description: "Полное руководство по передаче данных при навигации Shell в .NET MAUI 11: регистрация глобальных маршрутов, строковые параметры запроса, QueryPropertyAttribute против IQueryAttributable, асимметрия URL-декодирования между ними, одноразовые ShellNavigationQueryParameters против перегрузки с IDictionary, которая удерживает объект в памяти, передача данных назад через ..?key=value и почему QueryPropertyAttribute небезопасен при обрезке."
pubDate: 2026-07-28
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "shell"
  - "navigation"
  - "how-to"
lang: "ru"
translationOf: "2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-07-28
---

Чтобы передать данные на страницу при навигации Shell в .NET MAUI 11, зарегистрируйте целевую страницу как глобальный маршрут через `Routing.RegisterRoute("details", typeof(DetailPage))`, выполните переход через `await Shell.Current.GoToAsync($"details?id={id}")` и примите значение либо пометив принимающий класс атрибутом `[QueryProperty(nameof(Id), "id")]`, либо реализовав `IQueryAttributable.ApplyQueryAttributes`. Предпочитайте `IQueryAttributable`: `QueryPropertyAttribute` небезопасен при обрезке и ломается при полной обрезке или Native AOT. Для всего, что не является строкой, используйте перегрузку `GoToAsync(string, ShellNavigationQueryParameters)` вместо варианта с `IDictionary<string, object>`, потому что версия со словарём удерживает ваш объект в памяти на протяжении всего времени жизни страницы.

Эта статья ориентирована на .NET MAUI 11 (на момент написания Preview 6, релиз в ноябре 2026 года) и C# 14. API навигации Shell стабилен начиная с .NET MAUI 8, поэтому всё, кроме специфичных для .NET 11 замечаний в конце, применимо и к .NET MAUI 8, 9 и 10.

## Как Shell превращает URI в страницу

Навигация Shell построена на URI. Полный навигационный URI состоит из трёх частей и имеет вид `//route/page?queryParameters`:

- **Маршрут** задаёт путь внутри визуальной иерархии Shell, составленный из свойств `Route`, которые вы задаёте на `FlyoutItem`, `TabBar`, `Tab` и `ShellContent`.
- **Страница** представляет то, что не существует в визуальной иерархии и помещается в стек навигации по требованию. Страницы деталей почти всегда именно такие.
- **Параметры запроса** составляют хвост `?key=value&key2=value2`.

Это разделение важнее, чем кажется, потому что два вида назначений подчиняются противоположным правилам:

| | Объявлено в `AppShell.xaml` | Зарегистрировано через `Routing.RegisterRoute` |
| --- | --- | --- |
| Достигается через | абсолютный маршрут, `//animals/monkeys` | относительный маршрут, `monkeydetails` |
| Создаёт стек навигации | нет | да |
| Работает с другой формой | только абсолютной | только относительной |

Абсолютные маршруты не работают со страницами, зарегистрированными через `Routing.RegisterRoute`, а относительные маршруты не работают со страницами, объявленными внутри вашего подкласса `Shell`. Путаница здесь остаётся самой частой причиной `ArgumentException` при вызове `GoToAsync`, который выглядит правильным.

## Настройка маршрута к странице деталей за пять шагов

1. **Задайте элементам Shell явные маршруты.** Каждый элемент иерархии получает маршрут независимо от того, задали вы его или нет, но сгенерированные маршруты не гарантируют согласованности между сессиями приложения, поэтому никогда на них не полагайтесь:

   ```xml
   <!-- AppShell.xaml, .NET MAUI 11 -->
   <Shell xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
          x:Class="OrdersApp.AppShell">
       <TabBar>
           <ShellContent Title="Orders"
                         Route="orders"
                         ContentTemplate="{DataTemplate local:OrdersPage}" />
           <ShellContent Title="Settings"
                         Route="settings"
                         ContentTemplate="{DataTemplate local:SettingsPage}" />
       </TabBar>
   </Shell>
   ```

2. **Зарегистрируйте страницу деталей как глобальный маршрут** в конструкторе подкласса `Shell` или в любом другом месте, которое выполняется до первого обращения к маршруту:

   ```csharp
   // AppShell.xaml.cs, .NET MAUI 11
   public partial class AppShell : Shell
   {
       public AppShell()
       {
           InitializeComponent();
           Routing.RegisterRoute("orderdetails", typeof(OrderDetailPage));
       }
   }
   ```

   Регистрация одной и той же строки маршрута для двух разных типов бросает `ArgumentException`, как и обнаруженный при запуске дубликат маршрута в визуальной иерархии.

3. **Зарегистрируйте страницу и её view model в контейнере внедрения зависимостей**, чтобы Shell мог сконструировать их вместе с зависимостями:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11
   builder.Services.AddTransient<OrderDetailPage>();
   builder.Services.AddTransient<OrderDetailViewModel>();
   ```

4. **Задавайте `BindingContext` в конструкторе страницы**, а не в `OnAppearing`. Shell применяет query attributes к странице *и* к её `BindingContext` сразу после конструирования страницы, задолго до вызова `OnAppearing`. View model, присоединённая позже, параметров уже не увидит:

   ```csharp
   public partial class OrderDetailPage : ContentPage
   {
       public OrderDetailPage(OrderDetailViewModel vm)
       {
           InitializeComponent();
           BindingContext = vm;   // must happen here
       }
   }
   ```

5. **Выполняйте переход и всегда используйте `await`.** Навигация без ожидания создаёт состояние гонки: код после вызова может выполниться до завершения перехода, что проявляется как отсутствующие параметры запроса, устаревшее значение `Shell.Current.CurrentPage` или молча не сработавший переход.

   ```csharp
   // Correct
   await Shell.Current.GoToAsync($"orderdetails?id={order.Id}");

   // Wrong: race condition
   Shell.Current.GoToAsync($"orderdetails?id={order.Id}");
   ```

## Приём строковых параметров: два API и одно важное различие

Оба механизма приёма работают как на классе страницы, так и на классе, используемом в качестве её `BindingContext`.

`QueryPropertyAttribute` сопоставляет один идентификатор параметра запроса с одним свойством. Первый аргумент задаёт имя свойства, второй задаёт идентификатор параметра в URI:

```csharp
// .NET MAUI 11, C# 14
[QueryProperty(nameof(OrderId), "id")]
[QueryProperty(nameof(CustomerName), "customer")]
public partial class OrderDetailPage : ContentPage
{
    public string OrderId { set => LoadOrder(value); }
    public string CustomerName { set => Title = value; }
}
```

`IQueryAttributable` отдаёт всё в одном словаре, и это именно то, что нужно, как только два параметра приходится проверять вместе:

```csharp
// .NET MAUI 11, C# 14
public partial class OrderDetailViewModel : ObservableObject, IQueryAttributable
{
    [ObservableProperty]
    private Order? _order;

    public void ApplyQueryAttributes(IDictionary<string, object> query)
    {
        if (!query.TryGetValue("id", out var raw) || !int.TryParse(raw?.ToString(), out var id))
            return;

        var customer = HttpUtility.UrlDecode(query["customer"].ToString());
        Order = _repository.Load(id, customer);
    }
}
```

Обратите внимание на вызов `HttpUtility.UrlDecode`, потому что здесь скрыта асимметрия, которая стоит половины рабочего дня: **строковые значения параметров запроса, полученные через `QueryPropertyAttribute`, декодируются из URL автоматически, а полученные через `IQueryAttributable` не декодируются.** Перевод класса с атрибута на интерфейс без добавления декодирования превращает `Acme%20Corp` в буквальное `Acme%20Corp` в интерфейсе.

Соответствующее правило на стороне отправителя: кодируйте всё, что может содержать `&`, `?`, `#`, `=` или пробел:

```csharp
// .NET MAUI 11, C# 14
var url = $"orderdetails?id={order.Id}&customer={Uri.EscapeDataString(order.CustomerName)}";
await Shell.Current.GoToAsync(url);
```

Без `Uri.EscapeDataString` клиент с именем "Smith & Sons" обрежет параметр на амперсанде и молча создаст фантомный параметр `Sons`.

## Передача объектов и перегрузка, удерживающая память

Строковых параметров достаточно для идентификаторов. Для чего-то более сложного есть две перегрузки, и ведут они себя совершенно по-разному.

Перегрузка с `IDictionary<string, object>` передаёт данные **многократного использования**:

```csharp
// .NET MAUI 11, C# 14
var parameters = new Dictionary<string, object> { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

Переданные так данные удерживаются в памяти на всё время жизни страницы и не освобождаются, пока страница не покинет стек навигации. Кроме того, они доставляются повторно на обратном пути: если `Page1` передаёт `MyData` в `Page2`, а `Page2` помещает в стек `Page3`, то при снятии `Page3` страница `Page2` снова получает `MyData`. Такая повторная доставка иногда именно то, что нужно, и обычно то, чего вы не ожидали. Если она не нужна, вызовите `Clear()` на словаре после того, как принимающая страница его прочитала.

Перегрузка с `ShellNavigationQueryParameters` передаёт данные **однократного использования**, которые Shell очищает за вас после завершения перехода:

```csharp
// .NET MAUI 11, C# 14
var parameters = new ShellNavigationQueryParameters { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

`ShellNavigationQueryParameters` реализует `IDictionary<string, object>`, поэтому принимающая сторона выглядит одинаково. По умолчанию используйте именно её. К обычному словарю прибегайте только тогда, когда повторная доставка при возврате нужна вам осознанно.

Оба варианта можно совместить в одном вызове: URI со строковыми параметрами запроса плюс словарь объектов. Принимающий `ApplyQueryAttributes` получит один объединённый словарь с обоими наборами ключей.

## Передача данных назад

Навигация назад выполняется через `..`, и к ней можно добавлять параметры запроса. Это чистый способ вернуть результат со страницы выбора без шины сообщений и общего синглтона:

```csharp
// On the picker page, .NET MAUI 11
await Shell.Current.GoToAsync($"..?selectedId={selected.Id}");
```

Предыдущая страница получит `selectedId` через тот механизм, который она использует, ровно так же, как если бы переход к ней шёл вперёд. Объекты тоже работают:

```csharp
var result = new ShellNavigationQueryParameters { ["Selection"] = selected };
await Shell.Current.GoToAsync("..", result);
```

`..` комбинируется: `"../../route"` снимает две страницы и затем переходит к `route`. Это работает только если после снятия вы действительно оказываетесь в точке иерархии, из которой `route` достижим.

## Контекстные маршруты

Глобальные маршруты можно регистрировать по пути, а не по одному имени, и тогда один и тот же относительный маршрут разрешается в разные страницы в зависимости от того, где вы находитесь:

```csharp
// AppShell.xaml.cs, .NET MAUI 11
Routing.RegisterRoute("orders/details", typeof(OrderDetailPage));
Routing.RegisterRoute("invoices/details", typeof(InvoiceDetailPage));
```

Теперь `await Shell.Current.GoToAsync("details?id=42")` открывает `OrderDetailPage` из раздела заказов и `InvoiceDetailPage` из раздела счетов. Это аккуратный способ избавить общую `ItemsViewModel` от ветвлений, зависящих от назначения.

## Подводные камни, о которых стоит знать до выпуска

**`QueryPropertyAttribute` небезопасен при обрезке.** Начиная с .NET MAUI 9 в документации есть явное предупреждение: атрибут находит свойство через рефлексию и не должен использоваться с полной обрезкой или Native AOT. Вместо него реализуйте `IQueryAttributable` на любом типе, принимающем параметры запроса. Если ваше приложение движется к обрезанной или AOT-публикации, считайте это решающим фактором при выборе между двумя API, а не вопросом стиля. Моя статья о том, [что такое безопасный при обрезке код](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/), объясняет, как заставить анализатор рассказать вам об остальном ещё до публикации.

**`//page` и `///page` недопустимы.** Сейчас глобальный маршрут не может быть единственной страницей в стеке навигации, поэтому абсолютная маршрутизация к глобальному маршруту бросает исключение. Абсолютные маршруты предназначены только для визуальной иерархии.

**Переход к несуществующему маршруту бросает `ArgumentException`.** Молчаливого игнорирования и запасного маршрута нет, поэтому опечатка в строке маршрута приводит к падению, а не к пустой странице. Держите имена маршрутов в `static class Routes` с полями `const string` и используйте их и при регистрации, и при переходе.

**`Tab.Stack` доступен только для чтения.** Добавлять, удалять или переупорядочивать страницы его изменением нельзя. Чтобы сбросить стек, перейдите по абсолютному маршруту (`//orders`); чтобы вернуться, используйте `..`.

**Сеттеры свойств срабатывают в порядке атрибутов, а не в порядке URI.** При нескольких атрибутах `[QueryProperty]` не пишите сеттер, который предполагает, что другой параметр уже пришёл. Если два значения надо проверять вместе, это ровно тот случай, ради которого существует `IQueryAttributable`.

**Отложенная навигация блокирует `GoToAsync`.** Если вы используете `args.GetDeferral()` внутри переопределения `OnNavigating`, `GoToAsync` бросит `InvalidOperationException`, пока отсрочка не завершена. Учтите, что в .NET MAUI 10 и 11 API диалогов переименованы, поэтому канонический пример отсрочки теперь использует `DisplayActionSheetAsync` вместо `DisplayActionSheet`.

## Что изменилось для Shell в .NET MAUI 11

Сам контракт навигации в .NET 11 не изменился, и это сделано намеренно: релиз сосредоточен на качестве. Три вещи вокруг заслуживают внимания.

Начиная с .NET 11 Preview 6 **приложения Shell на Android по умолчанию используют архитектуру Shell на основе handler'ов** ([PR #34758](https://github.com/dotnet/maui/pull/34758)). Устаревший путь `ShellRenderer` остаётся доступным, если зарегистрировать его явно. Если у вас есть собственные Android-рендереры Shell, именно это изменение стоит проверить на регрессии в первую очередь.

Начиная с Preview 5 у `BackButtonBehavior` появилось свойство **`AccessibilityLabel`** ([PR #35011](https://github.com/dotnet/maui/pull/35011)). Оно независимо от `TextOverride`, поэтому видимая подпись может остаться короткой, а озвучиваемая может остаться описательной. Задавайте его всякий раз, когда задаёте `IconOverride`, потому что для голой иконки программе чтения с экрана нечего произнести:

```xml
<!-- .NET MAUI 11 -->
<Shell.BackButtonBehavior>
    <BackButtonBehavior IconOverride="back.png"
                        AccessibilityLabel="Back to order list" />
</Shell.BackButtonBehavior>
```

И среда выполнения под всем этим изменилась: CoreCLR теперь используется по умолчанию на всех платформах .NET MAUI, о чём я писал в статье [MAUI на мобильных становится CoreCLR only в Preview 6](/ru/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). На семантику навигации это не влияет, но влияет на профиль обрезки и запуска приложения, по которому вы перемещаетесь, что снова возвращает нас к рекомендации использовать `IQueryAttributable`.

## Связанные материалы

- [Миграция с Xamarin.Forms 5.0 на .NET MAUI 11: полный чек-лист](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/), где разобрана обвязка `AppShell`, без которой всё вышеописанное неприменимо.
- [Миграция производительного ListView из Xamarin.Forms на MAUI CollectionView](/ru/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/), ради обработчика изменения выбора, который обычно и запускает переход к деталям.
- [Как регистрировать и получать сервисы по ключу во внедрении зависимостей .NET 11](/ru/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/), полезно, когда двум маршрутам нужны разные реализации одного интерфейса репозитория.
- [Что такое Native AOT и чего он вам стоит?](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/), о режиме публикации, при котором `QueryPropertyAttribute` неприменим.
- [Как правильно поддержать тёмную тему в приложении .NET MAUI](/ru/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/), потому что оформление Shell первым выдаёт недоделанную поддержку тем.

## Источники

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation), Microsoft Learn, моникер .NET MAUI 11.
- [ShellNavigationQueryParameters class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.shellnavigationqueryparameters), справочник API .NET MAUI.
- [IQueryAttributable interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.iqueryattributable), справочник API .NET MAUI.
- [What's new in .NET MAUI for .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Handler Shell на Android по умолчанию, dotnet/maui PR #34758](https://github.com/dotnet/maui/pull/34758).
- [Метка доступности кнопки "Назад", dotnet/maui PR #35011](https://github.com/dotnet/maui/pull/35011).

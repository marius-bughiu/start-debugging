---
title: "Производительность ListView в Xamarin и его замена на Syncfusion SfListView"
description: "Повысьте производительность скролла ListView в Xamarin Forms с помощью стратегий caching, оптимизации шаблонов и Syncfusion SfListView."
pubDate: 2017-12-16
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2017/12/xamarin-listview-performance"
translatedBy: "claude"
translationDate: 2026-05-01
---
Хотя Xamarin продолжает добавлять возможности и повышать производительность Xamarin Forms с каждым обновлением, того, что они предлагают в кроссплатформенных user controls, не всегда хватает. У меня, например, есть RSS-ридер, который агрегирует новостные статьи из разных источников и показывает их в ListView вот так:

Внешний вид мне нравится, но у приложения есть большая проблема - производительность. Даже на топовых устройствах прокрутка тормозит, а на слабых - постоянно вылетают OutOfMemory exceptions из-за загружаемых картинок. В общем, нужны были изменения. В этой статье я разберу только первое - производительность скролла; OutOfMemory exceptions посмотрим в другой раз.

### Item template

Первое, на что стоит смотреть при разборе производительности, - ItemTemplate ListView. Любая оптимизация на этом уровне сильно влияет на общую производительность ListView. Обращайте внимание на:

-   уменьшение числа XAML-элементов. Чем меньше нужно отрисовывать, тем лучше
-   то же касается вложенности. Избегайте вложенных элементов и глубоких иерархий. Их рендеринг займёт слишком много времени
-   убедитесь, что ваш ItemSource - это IList, а не IEnumerable. IEnumerable не поддерживает произвольный доступ
-   не меняйте layout в зависимости от BindingContext. Используйте DataTemplateSelector

После этих изменений вы уже должны заметить улучшение скролла. Дальше - стратегия caching.

### Стратегия caching

По умолчанию Xamarin использует стратегию RetainElement для Android и iOS, то есть создаёт по одному экземпляру ItemTemplate на каждый элемент списка. Поменяйте caching strategy у ListView на RecycleElement, чтобы переиспользовать контейнеры, ушедшие из видимой области, вместо создания новых каждый раз. Это повысит производительность за счёт исключения затрат на инициализацию.

```xml
<ListView CachingStrategy="RecycleElement">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
              ...
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

Если случайно используете DataTemplateSelector, выбирайте стратегию RecycleElementAndDataTemplate. Подробнее о стратегиях caching - в [документации Xamarin](https://learn.microsoft.com/en-us/xamarin/xamarin-forms/user-interface/listview/performance) о производительности ListView.

### Syncfusion ListView

Если до сюда дошли, а проблемы с производительностью так и не ушли - пора смотреть на другие варианты. Я попробовал Syncfusion SfListView, потому что компания известна своими наборами controls и предоставляет Xamarin-controls бесплатно на тех же условиях, что Visual Studio Community (плюс-минус). Чтобы начать, зайдите на сайт Syncfusion и [получите бесплатную community-лицензию](https://www.syncfusion.com/products/communitylicense), если ещё нет.

Затем добавьте пакет SfListView в проект. Пакеты Syncfusion доступны в их собственном NuGet-репозитории. Чтобы получить к нему доступ, добавьте его в свои NuGet sources. Полное руководство, как это сделать, есть [здесь](https://help.syncfusion.com/xamarin/listview/getting-started). После этого простой поиск SfListView в NuGet даст нужный пакет. Установите его и в основной/кроссплатформенный проект, и во все платформозависимые проекты; правильные DLL подберутся автоматически в зависимости от target.

Теперь, когда всё установлено, пора заменить стандартный ListView. В page/view добавьте пространство имён:

```xml
xmlns:sflv="clr-namespace:Syncfusion.ListView.XForms;assembly=Syncfusion.SfListView.XForms"
```

Затем замените тег ListView на sflv:ListView, ListView.ItemTemplate на sflv:SfListView.ItemTemplate и удалите ViewCell из иерархии - он не нужен. Также, если использовали свойство CachingStrategy, уберите и его - SfListView переиспользует элементы по умолчанию. Должно получиться примерно так:

```xml
<sflv:SfListView>
    <sflv:SfListView.ItemTemplate>
        <DataTemplate>
           ...
        </DataTemplate>
    </sflv:SfListView.ItemTemplate>
</sflv:SfListView>
```

Вот и всё. Если есть вопросы, пишите в комментариях ниже. И если у вас есть свои советы по улучшению производительности ListView - поделитесь.

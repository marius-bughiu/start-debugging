---
title: "Начинаем работать с CSS в Xamarin Forms 3"
description: "Узнайте, как использовать Cascading StyleSheets (CSS) в Xamarin Forms 3, включая встраиваемые CDATA-стили и встраиваемые CSS-файлы."
pubDate: 2018-04-18
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2018/04/getting-started-with-css-in-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
В этой новой версии Xamarin Forms есть несколько нововведений, и одно из них - Cascading StyleSheets (CSS). Да, верно: CSS в XAML. Пока непонятно, насколько это окажется полезно и распространено - довольно много возможностей ещё отсутствует, - но, думаю, это будет приятным дополнением для тех, кто переходит из веб-разработки.

Сразу к делу - есть два способа добавить CSS в приложение:

-   первый - класть стили прямо в resources элемента и оборачивать их в тег CDATA
-   а второй - использовать настоящие .css файлы, добавленные как embedded resources в проект

И как только CSS подключен, вы используете его, указывая на XAML-элементе либо **StyleClass**, либо короткое свойство **class**.

Для примера сделаем несколько изменений в новом проекте Xamarin Forms на шаблоне master detail. Дальше: File > New project и обновите его до Xamarin Forms 3.

Сначала путь через CDATA. Допустим, мы хотим сделать элементы списка оранжевыми. Перейдите в ItemsPage и в XAML, выше тега `<ContentPage.ToolbarItems>`, добавьте:

```xml
<ContentPage.Resources>
    <StyleSheet>
        <![CDATA[

            .my-list-item {
                padding: 20;
                background-color: orange;
                color: white;
            }

        ]]>
    </StyleSheet>
</ContentPage.Resources>
```

Теперь нужно использовать новый класс .my-list-item. Найдите ItemTemplate вашего ListView и обратите внимание на StackLayout внутри - это наша цель. Уберите padding и примените класс так:

```xml
<StackLayout Padding="10" class="my-list-item">
```

Вот и всё.

Теперь рассмотрим второй подход - со встроенными CSS-файлами. Сначала создайте новую папку в приложении с именем Styles и в ней - новый файл about.css (в этой части стилизуем страницу About). После создания файла обязательно щёлкните правой кнопкой > Properties и установите **Build action** в **Embedded resource**; иначе работать не будет.

Теперь во view -- AboutPage.xaml -- добавьте следующий фрагмент сразу над элементом <ContentPage.BindingContext>. Это подключит наш CSS-файл к странице. Тот факт, что путь начинается с "/", означает, что он отсчитывается от корня. Можно указывать и относительные пути, опуская первый слэш.

```xml
<ContentPage.Resources>
   <StyleSheet Source="/Styles/about.css" />
</ContentPage.Resources>
```

А в CSS внесём небольшие изменения в заголовок приложения и кнопку learn more:

```css
.app-name {
    font-size: 48;
    color: orange;
}

.learn-more {
    border-color: orange;
    border-width: 1;
}
```

Аккуратнее: font-size и border-width - простые (double) значения; не указывайте "px", это не сработает и приведёт к ошибке. Полагаю, значения трактуются в DIP (device independent pixels). То же касается других свойств вроде thickness, margin, padding и так далее.

Теперь всё красиво и нарядно, но имейте в виду, что есть ограничения:

-   В этой версии поддерживаются не все селекторы. Селекторы \[attribute\], @media и @supports, а также : и :: пока не работают. Также по моим экспериментам адресация элемента двумя классами вроде .class1.class2 тоже не работает.
-   Поддерживаются не все свойства, и, что важнее, не все поддерживаемые свойства работают на всех элементах. Например, свойство text-align поддерживается только для Entry, EntryCell, Label и SearchBar, так что выровнять по левому краю текст у Button нельзя. А свойство border-width работает только с buttons.
-   Наследование не поддерживается

Полный список того, что поддерживается, а что нет, можно посмотреть в [pull request этой возможности на GitHub](https://github.com/xamarin/Xamarin.Forms/pull/1207). На случай, если что-то пойдёт не так / не заработает, исходный репозиторий с примером больше не доступен на GitHub, но сниппетов выше хватит для старта.

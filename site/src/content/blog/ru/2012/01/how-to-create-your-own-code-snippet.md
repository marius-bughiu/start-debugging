---
title: "Как создавать собственные code snippets в Visual Studio"
description: "Пошаговое руководство по созданию собственных code snippets в Visual Studio 2010, включая простые сниппеты и использование literals для заменяемых параметров."
pubDate: 2012-01-14
updatedDate: 2023-11-04
tags:
  - "visual-studio"
lang: "ru"
translationOf: "2012/01/how-to-create-your-own-code-snippet"
translatedBy: "claude"
translationDate: 2026-05-01
---
Здесь я объясню, как создать собственные code snippets для использования в Visual Studio 2010, не прибегая к add-in для дизайна сниппетов. Пост о snippet designers / explorers и о том, как с их помощью делать сниппеты лучше и быстрее, появится, наверное, на следующей неделе, но в этот раз обещать не могу.

## Часть 1: создаём простой code snippet

Поехали. Откройте Visual Studio и зайдите в **File - New File** (или Ctrl + N), создайте новый XML-файл. Пока не переживайте об имени файла - это не так важно. Автоматически создастся XML-файл с одной строкой кода. Первое, что нужно сделать в этом файле, - добавить namespace **CodeSnippets** и элемент **CodeSnippet** сразу после первой строки; для этого скопируйте код ниже:

```xml
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
   </CodeSnippet>
</CodeSnippets>
```

Теперь действительно можно начинать работу над сниппетом. Сначала готовим заголовок (header). В нём может быть разная информация: **Title, Description, Author, Keywords** (если хотите выложить сниппет онлайн), **Shortcut** для сниппета и **HelpUrl**, куда люди могут обратиться за помощью, если что-то идёт не так. Рекомендую всегда добавлять title и description, даже если они не обязательны.

Пример заголовка со всеми возможными элементами:

```xml
<Header>
   <Title>MessageBox</Title>
   <Description>Opens up a message box displaying "Hello World!".</Description>
   <Author>StartDebugging.net</Author>
   <Keywords>
      <Keyword>messagebox</Keyword>
      <Keyword>helloworld</Keyword>
   </Keywords>
   <Shortcut>hellobox</Shortcut>
   <HelpUrl>http://startdebugging.net</HelpUrl>
</Header>
```

Теперь, когда заголовок готов, можно писать код. Сначала создаём элемент **Snippet** сразу после закрытия Header. Ваш код должен выглядеть так:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
      <Header>
         ...
      </Header>
      <Snippet>
      </Snippet>
   </CodeSnippet>
</CodeSnippets>
```

Код, который сниппет должен вставить, помещается в элемент **Code** внутри **Snippet** между маркерами `<![CDATA[` и `]]>`. В этом примере, как вы, возможно, поняли по описанию, наш сниппет просто покажет message box с текстом "Hello World!". Ниже видно, как выглядит элемент **Code** после добавления кода.

```xml
<Snippet>
   <Code Language="CSharp">
      <![CDATA[MessageBox.Show("Hello World!");]]>
   </Code>
</Snippet>
```

Как видите, у моего элемента **Code** есть свойство **Language**, установленное в **CSharp**. Обязательно ставьте корректный language. Можно писать сниппеты для VB, CSharp, VJSharp и XML.

К **Snippet** также можно добавить элемент **References**. К сожалению, для C# это не поддерживается, поэтому references придётся добавлять вручную. В остальных случаях это делается так:

```xml
<Snippet>
   <References>
      <Reference>
         <Assembly>System.Windows.Forms.dll</Assembly>
      </Reference>
   </References>
   <Code Language="VB">
      ...
   </Code>
</Snippet>
```

Полный код сниппета:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
      <Header>
         <Title>MessageBox</Title>
         <Description>Opens up a message box displaying "Hello World!".</Description>
         <Author>StartDebugging.net</Author>
         <Keywords>
            <Keyword>messagebox</Keyword>
            <Keyword>helloworld</Keyword>
         </Keywords>
         <Shortcut>hellobox</Shortcut>
         <HelpUrl>http://startdebugging.net</HelpUrl>
      </Header>
      <Snippet>
         <Code Language="CSharp">
            <![CDATA[MessageBox.Show("Hello World");]]>
         </Code>
      </Snippet>
   </CodeSnippet>
</CodeSnippets>
```

Сниппет готов - время сохранять. **File - Save as** в путь:

```plaintext
Drive:\...\Documents\Visual Studio Version\Code Snippets\Language\
```

в нашем случае это

```plaintext
Drive:\...\Documents\Visual Studio 2010\Code Snippets\Visual C#\
```

с расширением **.snippet**, например **messagebox.snippet**.

После сохранения нужно добавить его в Visual Studio 2010. Зайдите в **Tools - Code Snippets Manager** (или Ctrl + K, Ctrl + B), нажмите **Import** и откройте только что сохранённый сниппет. Затем вас спросят, к каким language его добавить - в нашем случае просто отметьте **Visual C#**.

Создайте новый проект или откройте уже существующий (C#-проект) и перейдите в место, где можно писать C#-код. Вставить сниппет можно двумя способами: первый - нажать Ctrl + K, Ctrl + X, выбрать Visual C# (или другой language), затем выбрать нужный сниппет (наш называется MessageBox - имя задаётся через тег **Title**); второй - набрать shortcut (наш - **hellobox**, задано тегом **Shortcut** в заголовке) и дважды нажать **TAB.** Готово, сниппет вставлен.

## Часть 2: используем literals

Теперь, когда вы умеете создавать, сохранять и использовать code snippet, пора освоить более сложные сниппеты - речь о **literals**.

Так как лучшего определения literals у меня не нашлось, вот то, что я нашёл на msdn:

> Элемент **Literal** используется для обозначения замены в участке кода, который полностью находится внутри сниппета, но, скорее всего, будет настраиваться после вставки в код.

Допустим, в сниппете имя переменной используется 10 раз. Вы вставляете сниппет в код и решаете, что имя нужно поменять; идёте и меняете имя в каждом из 10 мест. Literals позволяют определить кусочек кода в сниппете, который можно использовать многократно: после вставки сниппета, если вы поменяете этот кусок в одном месте, он изменится во всех остальных местах, где использовался. Можно представить их как переменные, если хотите.

Применим это на практике. Создадим сниппет для вставки dependency properties в проектах Silverlight. Код для регистрации dependency property с обработчиком property changed:

```cs
public bool IsSelected
{
   get { return (bool)GetValue(IsSelectedProperty); }
   set { SetValue(IsSelectedProperty, value); }
}
public static readonly DependencyProperty IsSelectedProperty = DependencyProperty.Register("IsSelected", typeof(Boolean), typeof(Page), new PropertyMetadata(OnIsSelectedPropertyChanged));
private static void OnIsSelectedPropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
{
   Page control = d as Page;
}
```

Как видите, имя свойства используется несколько раз, как и тип, поэтому определим literal для каждого из них + literal для имени класса. Они выглядят так:

```xml
<Snippet>
   <Declarations>
      <Literal>
         <ID>PropertyName</ID>
         <Default>PropertyName</Default>
         <ToolTip>The name of the dependency property.</ToolTip>
      </Literal>
      <Literal>
         <ID>PropertyType</ID>
         <Default>PropertyType</Default>
         <ToolTip>The type of the dependency property.</ToolTip>
      </Literal>
      <Literal>
         <ID>ClassName</ID>
         <Default>ClassName</Default>
         <ToolTip>The name of the owner class.</ToolTip>
      </Literal>
   </Declarations>
</Snippet>
```

Как видите, у каждого literal три поля: **ID** - идентификатор заменяемых участков кода, **Default** - значение по умолчанию для literal при вставке сниппета, и **ToolTip** - короткое описание, которое появляется при наведении мыши.

С готовыми literals остаётся заменить уже определённые имена и типы в коде на literals. Делается это с помощью **$ID$** вместо предопределённого значения (например, $PropertyName$, $PropertyType$, $ClassName$).

После замены ваш код в сниппете выглядит так:

```xml
<Code Language="CSharp">
   <![CDATA[// Defines a DependencyProperty named $PropertyName$ of type $PropertyType$ for the $ClassName$ class.
   public $PropertyType$ $PropertyName$
   {
      get { return ($PropertyType$)GetValue($PropertyName$Property); }
      set { SetValue($PropertyName$Property, value); }
   }
   public static readonly DependencyProperty $PropertyName$Property = DependencyProperty.Register("$PropertyName$", typeof($PropertyType$), typeof($ClassName$), new PropertyMetadata(On$PropertyName$PropertyChanged));
   private static void On$PropertyName$PropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
   {
      $ClassName$ control = d as $ClassName$;
   }]]>
</Code>
```

И вот полный код:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
      <Header>
         <Title>sldp</Title>
         <Description>Defines a dependency property to use in Silverlight.</Description>
         <Author>StartDebugging.net</Author>
         <Keywords>
            <Keyword>silverlight</Keyword>
            <Keyword>dependencyproperty</Keyword>
         </Keywords>
         <Shortcut>sldp</Shortcut>
         <HelpUrl>http://startdebugging.net</HelpUrl>
      </Header>
      <Snippet>
         <Declarations>
            <Literal>
               <ID>PropertyName</ID>
               <Default>PropertyName</Default>
               <ToolTip>The name of the dependency property.</ToolTip>
            </Literal>
            <Literal>
               <ID>PropertyType</ID>
               <Default>PropertyType</Default>
               <ToolTip>The type of the dependency property.</ToolTip>
            </Literal>
            <Literal>
               <ID>ClassName</ID>
               <Default>ClassName</Default>
               <ToolTip>The name of the owner class.</ToolTip>
            </Literal>
         </Declarations>
         <Code Language="CSharp">
            <![CDATA[// Defines a DependencyProperty named $PropertyName$ of type $PropertyType$ for the $ClassName$ class.
            public $PropertyType$ $PropertyName$
            {
               get { return ($PropertyType$)GetValue($PropertyName$Property); }
               set { SetValue($PropertyName$Property, value); }
            }
            public static readonly DependencyProperty $PropertyName$Property = DependencyProperty.Register("$PropertyName$", typeof($PropertyType$), typeof($ClassName$), new PropertyMetadata(On$PropertyName$PropertyChanged));
            private static void On$PropertyName$PropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
            {
               $ClassName$ control = d as $ClassName$;
            }]]>
         </Code>
      </Snippet>
   </CodeSnippet>
</CodeSnippets>
```

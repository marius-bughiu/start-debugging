---
title: "How to create your own code snippets in Visual Studio"
description: "Okay, so what I will do here is explain you how to create your own code snippets to use in Visual Studio 2010 without using any add-ins related to snippet designing. A post on snippet designers / explorers and how you can use them to build better snippets faster will come sometime next week I…"
pubDate: 2012-01-14
updatedDate: 2023-11-04
tags:
  - "visual-studio"
---
Okay, so what I will do here is explain you how to create your own code snippets to use in Visual Studio 2010 without using any add-ins related to snippet designing. A post on snippet designers / explorers and how you can use them to build better snippets faster will come sometime next week I believe, but this time I can’t promise.

## Part 1: Creating a simple code snippet

So let’s get started. Open up your Visual Studio and go to **File – New File** (or Ctrl + N) and create a new XML file. Don’t worry about the file’s name at this point as it is not that important. An XML file with a line of code will automatically be generated for you. So, the first thing we need to do in this brand new file is to add the **CodeSnippets** namespace and a **CodeSnippet** element to it right after the first line; to do so copy-paste the code below:

```xml
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
   </CodeSnippet>
</CodeSnippets>
```

Now we can really start work on our snippet. First thing we need to do is set up the header of our snippet. The header can contain various information like the **Title, Description, Author,  Keywords** in case you want to make your snippet available online, a **Shortcut** for your snipped and also a **HelpUrl** where people can go and ask for help in case something doesn’t work as expected. I suggest you always add a title and a description to your snippets even if they are not mandatory.

Here’s an example of a header containing all possible elements:

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

Now that the header is set up, we can start writing the code. First thing here is creating the actual **Snippet** element right after the end of the Header element. Your code should look like this now:

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

The code which we want the snipped to insert must be added in the **Code** element of the **Snippet** between `<![CDATA[` and `]]>` brackets. In this example, as you’ve probably figured out from the description, our code snippet will simply display a message box containing the text “Hello World!”.  Bellow you can see how the **Code** element of the snippet looks like after adding the code.

```xml
<Snippet>
   <Code Language="CSharp">
      <![CDATA[MessageBox.Show("Hello World!");]]>
   </Code>
</Snippet>
```

As you can see above, my **Code** element has a property named **Language** which is set to **CSharp**. Make sure that you set that language accordingly. You can write code snippets for VB, CSharp, VJSharp and XML.

Also, another element which you can add to the **Snippet** is **References**. Unfortunately this is not supported for C# so you will have to add them manually in our case. Otherwise, here’s how you can add a reference:

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

So here’s the entire code of the snippet:

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

Now that we’re done writing the snippet it’s time to save it. So **File – Save as** to the following path:

```plaintext
Drive:\...\Documents\Visual Studio Version\Code Snippets\Language\
```

which in our case is

```plaintext
Drive:\...\Documents\Visual Studio 2010\Code Snippets\Visual C#\
```

using the **.snippet** file extension – for example **messagebox.snippet**.

Now that you’ve saved it, it’s time to add it to your Visual Studio 2010. So go to **Tools – Code Snippets Manager** (or Ctrl + K, Ctrl + B), click on **Import**  and open the snippet we previously saved. After opening it you will be asked to which languages to add it, in our case simply check **Visual C#**.

Create a new project or open an already existing one (C# project) and go somewhere where you can write some C# code. Now, inserting a snippet can be done two ways: one – hit Ctrl + K, Ctrl + X, select Visual C# (or any other language for that matter) and then select the snippet you want to insert (ours is called MessageBox – we set this name using the **Title** tag); – second way is by typing the shortcut (ours is called **hellobox** – we set this name using the **Shortcut** tag in the header) and pressing double **TAB.** And there you go, your snippet is inserted.

## Part 2: Using literals

Now that you know how to create, save and use a code snippet it’s time to learn how to create a little bit more complex ones – and here I’m referring to **literals**.

Since I couldn’t think of a better definition for literals, here’s the one I found on msdn:

> The **Literal** element is used to identify a replacement for a piece of code that is entirely contained within the snippet, but will likely be customized after it is inserted into the code.

So let’s say you have a code snippet in which you use a variable name 10 times. You insert that code snippet into your code and you decide that the variable name must be changed so you go ahead and replace the old variable name with the new variable name in all 10 cases. What literals allow you to do is define a piece of code inside your snippet which you can use several times, and after you insert that snippet into your code if you change that defined piece of code in one place, then it will change in all the other places where you used it. You can think of them as variables if you want.

So, let’s put them in practice. Let’s create a code snippet for inserting dependency properties in our silverlight projects. The code for registering a dependency property with a property changed event handler is the one below:

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

As you can see, the property name is used several times as well as the property type, so what we’re gonna do is define a literal for each of them + one literal for the class name. They look like this:

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

As you can see, each of my literals has three fields: **ID** – used to identify replaceable portions of code, **Default** – representing the default value of the literal when the snippet is inserted and **ToolTip** which is a small description of he literal which shows up at mouse over.

Having these literals set up what we need to next is replace the already defined names and types in our code with literals. This is done by using **$ID$** instead of the predefined value (ex: $PropertyName$, $PropertyType$, $ClassName$).

This is how your code should look like inside the snippet after adding the literals:

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

And here is the complete code:

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

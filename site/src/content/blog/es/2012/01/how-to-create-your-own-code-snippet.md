---
title: "Cómo crear tus propios code snippets en Visual Studio"
description: "Guía paso a paso para crear tus propios code snippets en Visual Studio 2010, incluyendo snippets simples y el uso de literals para parámetros reemplazables."
pubDate: 2012-01-14
updatedDate: 2023-11-04
tags:
  - "visual-studio"
lang: "es"
translationOf: "2012/01/how-to-create-your-own-code-snippet"
translatedBy: "claude"
translationDate: 2026-05-01
---
Lo que voy a hacer aquí es explicarte cómo crear tus propios code snippets para usar en Visual Studio 2010, sin usar ningún add-in relacionado con el diseño de snippets. Un post sobre snippet designers / explorers y cómo usarlos para construir mejores snippets más rápido vendrá la próxima semana, creo, pero esta vez no lo prometo.

## Parte 1: Crear un code snippet simple

Empecemos. Abre Visual Studio y ve a **File - New File** (o Ctrl + N) y crea un archivo XML nuevo. No te preocupes por el nombre del archivo en este momento, no es tan importante. Se generará automáticamente un archivo XML con una línea de código. Lo primero que tenemos que hacer en este archivo nuevo es añadir el namespace **CodeSnippets** y un elemento **CodeSnippet** justo después de la primera línea; para ello copia y pega el código de abajo:

```xml
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
   </CodeSnippet>
</CodeSnippets>
```

Ahora podemos empezar a trabajar en serio en nuestro snippet. Lo primero es preparar la cabecera. La cabecera puede contener varias informaciones como **Title, Description, Author, Keywords** (por si quieres ponerlo disponible online), un **Shortcut** para tu snippet y también un **HelpUrl** donde la gente pueda pedir ayuda si algo no funciona como se espera. Te sugiero añadir siempre un title y una description a tus snippets, aunque no sean obligatorios.

Aquí tienes un ejemplo de cabecera con todos los elementos posibles:

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

Con la cabecera lista, podemos empezar a escribir el código. Lo primero es crear el elemento **Snippet** justo después del cierre del Header. Tu código debería verse así ahora:

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

El código que queremos que el snippet inserte debe ir en el elemento **Code** del **Snippet**, entre las marcas `<![CDATA[` y `]]>`. En este ejemplo, como probablemente habrás deducido por la descripción, nuestro code snippet simplemente mostrará un message box con el texto "Hello World!". Abajo puedes ver cómo queda el elemento **Code** del snippet tras añadir el código.

```xml
<Snippet>
   <Code Language="CSharp">
      <![CDATA[MessageBox.Show("Hello World!");]]>
   </Code>
</Snippet>
```

Como puedes ver, mi elemento **Code** tiene una propiedad llamada **Language** ajustada a **CSharp**. Asegúrate de poner ese language de forma adecuada. Puedes escribir code snippets para VB, CSharp, VJSharp y XML.

Otro elemento que puedes añadir al **Snippet** es **References**. Lamentablemente esto no está soportado para C# así que en nuestro caso tendrás que añadirlas manualmente. En cualquier caso, así puedes añadir una reference:

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

Aquí tienes el código completo del snippet:

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

Una vez terminado el snippet es momento de guardarlo. **File - Save as** en la siguiente ruta:

```plaintext
Drive:\...\Documents\Visual Studio Version\Code Snippets\Language\
```

que en nuestro caso es

```plaintext
Drive:\...\Documents\Visual Studio 2010\Code Snippets\Visual C#\
```

usando la extensión **.snippet**, por ejemplo **messagebox.snippet**.

Ahora que lo has guardado, hay que añadirlo a Visual Studio 2010. Ve a **Tools - Code Snippets Manager** (o Ctrl + K, Ctrl + B), haz clic en **Import** y abre el snippet que acabamos de guardar. Después se te preguntará a qué languages añadirlo; en nuestro caso simplemente marca **Visual C#**.

Crea un proyecto nuevo o abre uno ya existente (proyecto C#) y ve a algún sitio donde puedas escribir código C#. Insertar un snippet se puede hacer de dos formas: una -- pulsa Ctrl + K, Ctrl + X, selecciona Visual C# (o cualquier otro language), y luego selecciona el snippet que quieras insertar (el nuestro se llama MessageBox, fijado con el tag **Title**); la segunda forma es escribiendo el shortcut (el nuestro se llama **hellobox**, fijado con el tag **Shortcut** en la cabecera) y pulsando doble **TAB.** Y ya está, tu snippet está insertado.

## Parte 2: Usar literals

Ahora que sabes crear, guardar y usar un code snippet, es momento de aprender a hacerlos un poco más complejos, y aquí me refiero a los **literals**.

Como no se me ocurría una definición mejor para los literals, esta es la que encontré en msdn:

> El elemento **Literal** se usa para identificar una sustitución en una pieza de código que está totalmente contenida dentro del snippet, pero que probablemente se personalizará después de insertarse en el código.

Pongamos que tienes un code snippet en el que usas un nombre de variable 10 veces. Insertas el snippet en tu código y decides que el nombre debe cambiar, así que reemplazas el nombre antiguo por el nuevo en los 10 sitios. Lo que los literals te permiten es definir una pieza de código dentro del snippet que puedes usar varias veces, y, tras insertarlo en el código, si cambias esa pieza en un sitio, cambia en todos los demás donde la usaste. Puedes pensar en ellos como variables si quieres.

Pongámoslos en práctica. Vamos a crear un code snippet para insertar dependency properties en proyectos Silverlight. El código para registrar una dependency property con un property changed event handler es el siguiente:

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

Como ves, el nombre de la propiedad se usa varias veces, igual que el tipo, así que vamos a definir un literal para cada uno de ellos, más un literal para el nombre de la clase. Quedan así:

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

Como puedes ver, cada literal tiene tres campos: **ID** -- usado para identificar las porciones reemplazables de código, **Default** -- que representa el valor por defecto del literal cuando se inserta el snippet, y **ToolTip**, que es una pequeña descripción del literal que aparece al pasar el ratón.

Con estos literals listos, lo siguiente es reemplazar los nombres y tipos ya definidos en nuestro código por los literals. Esto se hace usando **$ID$** en lugar del valor predefinido (ej.: $PropertyName$, $PropertyType$, $ClassName$).

Así debería verse tu código dentro del snippet tras añadir los literals:

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

Y aquí está el código completo:

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

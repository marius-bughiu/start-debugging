---
title: "Como criar seus próprios code snippets no Visual Studio"
description: "Guia passo a passo para criar seus próprios code snippets no Visual Studio 2010, incluindo snippets simples e o uso de literals para parâmetros substituíveis."
pubDate: 2012-01-14
updatedDate: 2023-11-04
tags:
  - "visual-studio"
lang: "pt-br"
translationOf: "2012/01/how-to-create-your-own-code-snippet"
translatedBy: "claude"
translationDate: 2026-05-01
---
O que vou fazer aqui é explicar como criar seus próprios code snippets para usar no Visual Studio 2010, sem usar nenhum add-in de design de snippets. Um post sobre snippet designers / explorers e como usá-los para criar snippets melhores e mais rápido virá em algum momento da próxima semana, eu acho, mas dessa vez não posso prometer.

## Parte 1: criando um code snippet simples

Vamos começar. Abra o Visual Studio e vá em **File - New File** (ou Ctrl + N) e crie um novo arquivo XML. Não se preocupe com o nome do arquivo agora, não é tão importante. Será gerado automaticamente um XML com uma linha de código. A primeira coisa que vamos fazer nesse arquivo novo é adicionar o namespace **CodeSnippets** e um elemento **CodeSnippet** logo após a primeira linha; copie e cole o código abaixo:

```xml
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
   </CodeSnippet>
</CodeSnippets>
```

Agora podemos começar a trabalhar de fato no nosso snippet. A primeira coisa é montar o header do snippet. Ele pode conter várias informações, como **Title, Description, Author, Keywords** (caso queira disponibilizá-lo online), um **Shortcut** para o snippet e também um **HelpUrl** onde as pessoas possam pedir ajuda quando algo não funcionar como esperado. Sugiro sempre adicionar um title e uma description aos seus snippets, mesmo não sendo obrigatórios.

Aqui vai um exemplo de header com todos os elementos possíveis:

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

Com o header pronto, podemos começar a escrever o código. Primeiro, criamos o elemento **Snippet** logo após o fechamento do Header. Seu código deve ficar assim agora:

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

O código que queremos que o snippet insira deve ser colocado no elemento **Code** do **Snippet**, entre as marcações `<![CDATA[` e `]]>`. Neste exemplo, como você já deve ter percebido pela descrição, nosso code snippet apenas exibe um message box com o texto "Hello World!". Veja como fica o elemento **Code** do snippet após adicionarmos o código.

```xml
<Snippet>
   <Code Language="CSharp">
      <![CDATA[MessageBox.Show("Hello World!");]]>
   </Code>
</Snippet>
```

Como você pode ver, meu elemento **Code** tem uma propriedade chamada **Language** definida como **CSharp**. Garanta que esse language esteja configurado corretamente. É possível escrever code snippets para VB, CSharp, VJSharp e XML.

Outro elemento que pode ser adicionado ao **Snippet** é **References**. Infelizmente, isso não tem suporte para C#, então no nosso caso você terá que adicioná-las manualmente. De qualquer forma, veja como adicionar uma reference:

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

Aqui está o código completo do snippet:

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

Pronto o snippet, é hora de salvá-lo. **File - Save as** no caminho:

```plaintext
Drive:\...\Documents\Visual Studio Version\Code Snippets\Language\
```

que no nosso caso é

```plaintext
Drive:\...\Documents\Visual Studio 2010\Code Snippets\Visual C#\
```

usando a extensão **.snippet** -- por exemplo, **messagebox.snippet**.

Agora que salvou, é hora de adicioná-lo ao Visual Studio 2010. Vá em **Tools - Code Snippets Manager** (ou Ctrl + K, Ctrl + B), clique em **Import** e abra o snippet que acabamos de salvar. Ao abrir, será perguntado a quais languages adicionar; no nosso caso, marque **Visual C#**.

Crie um novo projeto ou abra um já existente (projeto C#) e vá a algum lugar onde você possa escrever código C#. Inserir um snippet pode ser feito de duas formas: a primeira -- pressione Ctrl + K, Ctrl + X, selecione Visual C# (ou outro language), depois selecione o snippet que deseja inserir (o nosso se chama MessageBox -- definimos esse nome com o tag **Title**); a segunda -- digitando o shortcut (o nosso é **hellobox** -- definido com o tag **Shortcut** no header) e pressionando **TAB** duas vezes. Pronto, seu snippet está inserido.

## Parte 2: usando literals

Agora que você sabe criar, salvar e usar um code snippet, é hora de aprender a fazer alguns um pouco mais complexos -- estou falando dos **literals**.

Como não consegui pensar numa definição melhor para literals, esta é a que encontrei no msdn:

> O elemento **Literal** é usado para identificar uma substituição em um trecho de código que está totalmente contido dentro do snippet, mas que provavelmente será personalizado depois de ser inserido no código.

Suponha que você tem um code snippet onde usa um nome de variável 10 vezes. Você insere esse snippet no código e decide que precisa mudar esse nome, então substitui o nome antigo pelo novo nas 10 ocorrências. O que os literals permitem é definir um trecho de código dentro do snippet que pode ser usado várias vezes; depois de inserir o snippet, se você mudar esse trecho em um lugar, ele muda em todos os outros lugares onde foi usado. Pode pensar neles como variáveis, se quiser.

Vamos colocar isso em prática. Vamos criar um code snippet para inserir dependency properties em projetos Silverlight. O código para registrar uma dependency property com property changed event handler é o seguinte:

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

Como você vê, o nome da propriedade é usado várias vezes, assim como o tipo, então vamos definir um literal para cada um deles + um literal para o nome da classe. Eles ficam assim:

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

Como você pode ver, cada um dos meus literals tem três campos: **ID** -- usado para identificar trechos substituíveis, **Default** -- representa o valor padrão do literal quando o snippet é inserido, e **ToolTip**, que é uma pequena descrição do literal exibida ao passar o mouse.

Com esses literals prontos, o próximo passo é substituir os nomes e tipos já definidos no nosso código pelos literals. Isso é feito usando **$ID$** no lugar do valor predefinido (ex: $PropertyName$, $PropertyType$, $ClassName$).

Veja como deve ficar seu código dentro do snippet depois de adicionar os literals:

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

E aqui está o código completo:

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

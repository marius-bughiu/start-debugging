---
title: "Visual Studio で自分の code snippet を作る方法"
description: "Visual Studio 2010 で自分の code snippet を作るステップバイステップガイドです。シンプルな snippet と、置き換え可能なパラメーターのための literals の使用例を含みます。"
pubDate: 2012-01-14
updatedDate: 2023-11-04
tags:
  - "visual-studio"
lang: "ja"
translationOf: "2012/01/how-to-create-your-own-code-snippet"
translatedBy: "claude"
translationDate: 2026-05-01
---
ここでは、snippet 設計用の add-in を使わずに、Visual Studio 2010 で自分の code snippet を作って使う方法を説明します。snippet designers / explorers と、それらを使ってより良い snippet をより速く作る方法についての記事は、来週のどこかでと思っていますが、今回は約束はできません。

## パート 1: シンプルな code snippet を作る

それでは始めましょう。Visual Studio を開き、**File - New File** (または Ctrl + N) で新しい XML ファイルを作成します。今の段階ではファイル名はあまり重要ではないので気にしないでください。コードが 1 行だけある XML ファイルが自動生成されます。この新しいファイルでまず必要なのは、最初の行のすぐ後に **CodeSnippets** 名前空間と **CodeSnippet** 要素を追加することです。下のコードをコピーしてください。

```xml
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
   <CodeSnippet Format="1.0.0">
   </CodeSnippet>
</CodeSnippets>
```

これで本格的に snippet の作業を始められます。最初に snippet のヘッダー部を整えます。ヘッダーには **Title、Description、Author、Keywords** (snippet をオンライン公開する場合)、**Shortcut**、何かが期待どおりに動かない場合に問い合わせ先となる **HelpUrl** などの情報を含められます。必須ではありませんが、title と description は常に追加することをおすすめします。

すべての要素を含むヘッダーの例:

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

ヘッダーが整ったら、コードを書き始めます。まず Header 要素の終わり直後に、実際の **Snippet** 要素を作成します。コードはこんな感じになるはずです。

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

snippet で挿入したいコードは、**Snippet** 内の **Code** 要素に、`<![CDATA[` と `]]>` の間に書きます。description からお察しのとおり、この例の code snippet は単に "Hello World!" を含む message box を表示するだけです。コードを追加した後の **Code** 要素は次のようになります。

```xml
<Snippet>
   <Code Language="CSharp">
      <![CDATA[MessageBox.Show("Hello World!");]]>
   </Code>
</Snippet>
```

ご覧のとおり、**Code** 要素には **Language** プロパティがあり、**CSharp** に設定されています。language は適切に設定してください。code snippet は VB、CSharp、VJSharp、XML 向けに書けます。

**Snippet** に追加できるもう一つの要素として **References** があります。残念ながら C# ではサポートされていないため、私たちのケースでは手動で追加する必要があります。それ以外の場合は、reference を次のように追加できます。

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

snippet 全体のコードはこちら:

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

snippet が書き終わったら保存します。**File - Save as** で次のパスへ:

```plaintext
Drive:\...\Documents\Visual Studio Version\Code Snippets\Language\
```

私たちの場合は

```plaintext
Drive:\...\Documents\Visual Studio 2010\Code Snippets\Visual C#\
```

拡張子は **.snippet** です。例: **messagebox.snippet**。

保存できたら、Visual Studio 2010 に追加します。**Tools - Code Snippets Manager** (または Ctrl + K, Ctrl + B) を開き、**Import** をクリックして、先ほど保存した snippet を開きます。開いた後にどの language に追加するか聞かれるので、ここでは **Visual C#** にチェックを入れます。

新しいプロジェクトを作る、もしくは既存の C# プロジェクトを開いて、C# のコードを書ける場所に移動します。snippet の挿入は 2 通りあります: 1 つ目は Ctrl + K, Ctrl + X を押し、Visual C# (または他の language) を選び、挿入したい snippet を選ぶ方法 (うちのは MessageBox -- **Title** タグで設定した名前)。2 つ目は shortcut (うちのは **hellobox** -- ヘッダーの **Shortcut** タグで設定) を入力して **TAB** を 2 回押す方法。これで snippet が挿入されます。

## パート 2: literals を使う

code snippet の作成、保存、利用ができるようになったので、もう少し複雑なものを学びます。ここで言うのは **literals** のことです。

literals のいい説明が思いつかなかったので、msdn で見つけたものを紹介します。

> **Literal** 要素は、snippet 内に完全に含まれているものの、コードに挿入された後にカスタマイズされる可能性が高いコード片の置換を識別するために使用されます。

たとえば snippet の中で変数名を 10 回使っているとします。snippet をコードに挿入し、変数名を変更したいと思って、10 か所すべての古い変数名を新しい変数名に置き換える、というシナリオです。literals が可能にするのは、snippet 内で複数回利用するコード片を定義しておき、snippet を挿入した後、その定義したコード片を 1 か所で変更すれば、使ったすべての場所でも変わる、というものです。変数のようなものと考えてもよいでしょう。

実際にやってみましょう。Silverlight プロジェクトに dependency properties を挿入する code snippet を作ります。property changed event handler 付きで dependency property を登録するコードは次のとおりです。

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

ご覧のとおり、property の名前と型がそれぞれ何度も使われているので、それぞれに literal を、加えてクラス名にも literal を定義します。次のような形です。

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

各 literal には 3 つのフィールドがあります。**ID** -- 置換可能なコード部分を識別するためのもの、**Default** -- snippet が挿入された際の literal のデフォルト値、**ToolTip** -- マウスオーバー時に表示される literal の短い説明。

これらの literals を用意したら、次は既に定義された名前や型を literals に置き換えます。これは、事前定義の値の代わりに **$ID$** を使うことで行います (例: $PropertyName$, $PropertyType$, $ClassName$)。

literals を入れた後の snippet 内コードはこんな感じになります。

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

そして完成形のコードがこちらです。

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

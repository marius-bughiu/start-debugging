---
title: "Começando com CSS no Xamarin Forms 3"
description: "Aprenda a usar Cascading StyleSheets (CSS) no Xamarin Forms 3, incluindo estilos CDATA inline e arquivos CSS embutidos."
pubDate: 2018-04-18
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2018/04/getting-started-with-css-in-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Há algumas novidades chegando com essa nova versão do Xamarin Forms, e uma delas é Cascading StyleSheets (CSS). Sim, isso mesmo, CSS no XAML. Ainda não estou certo de quão útil será nem de quanto vai pegar -- algumas funcionalidades ainda estão faltando -- mas suponho que será uma boa adição para quem quiser migrar do desenvolvimento web.

Para ir direto ao ponto, há duas formas de adicionar CSS à sua aplicação:

-   a primeira é colocar os estilos diretamente nos resources do elemento e envolver com uma tag CDATA
-   a segunda envolve arquivos .css de fato, adicionados como embedded resources no seu projeto

Uma vez incluído o CSS, você o usa especificando **StyleClass** ou a propriedade abreviada **class** no seu elemento XAML.

Para exemplificar, faremos algumas alterações em um novo projeto Xamarin Forms usando o template master detail. Vai lá -- File > New project e atualize para o Xamarin Forms 3.

Primeiro, o caminho via CDATA. Suponha que queremos deixar os elementos da nossa lista em laranja. Vá até ItemsPage e dentro do XAML, acima da tag `<ContentPage.ToolbarItems>`, coloque isto:

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

Agora precisamos usar essa nova classe .my-list-item. Encontre o ItemTemplate da sua ListView e note o StackLayout interno -- esse é o nosso alvo. Remova aquele padding e aplique a nossa classe assim:

```xml
<StackLayout Padding="10" class="my-list-item">
```

E é isso.

Agora, vamos olhar a segunda abordagem, com arquivos CSS embutidos. Primeiro, crie uma nova pasta no app chamada Styles e dentro dela crie um novo arquivo chamado about.css (vamos estilizar a página About nesta parte). Depois de criar o arquivo, lembre-se de clicar com o botão direito > Properties e definir o **Build action** como **Embedded resource**; senão não vai funcionar.

Agora na nossa view -- AboutPage.xaml -- adicione o seguinte logo acima do elemento <ContentPage.BindingContext>. Isso vai referenciar nosso arquivo CSS na página. O fato do caminho começar com "/" significa que ele parte da raiz. Você também pode especificar caminhos relativos omitindo a primeira barra.

```xml
<ContentPage.Resources>
   <StyleSheet Source="/Styles/about.css" />
</ContentPage.Resources>
```

Quanto ao CSS, vamos fazer pequenas mudanças no título do app e no botão learn more, assim:

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

Cuidado: font-size e border-width são valores simples (double); não especifique "px", porque isso não vai funcionar e gera erro. Suponho que os valores informados sejam em DIP (device independent pixels). O mesmo vale para outras propriedades como thickness, margin, padding etc.

Tudo bonitinho, mas tenha em mente que há limitações:

-   Nem todos os seletores são suportados nesta versão. Os seletores \[attribute\], @media e @supports, ou os seletores : e ::. Eles ainda não funcionam. Além disso, pelo que testei, mirar um elemento com duas classes como .class1.class2 também não funciona.
-   Nem todas as propriedades são suportadas e, principalmente, nem todas as propriedades suportadas funcionam em todos os elementos. Por exemplo: a propriedade text-align é suportada apenas em Entry, EntryCell, Label e SearchBar, então você não pode alinhar à esquerda o texto de um Button. Ou se pegar a propriedade border-width -- ela só vai funcionar com buttons.
-   Herança não é suportada

Para uma lista completa do que é e do que não é suportado, dê uma olhada [no pull request feito para essa funcionalidade no GitHub](https://github.com/xamarin/Xamarin.Forms/pull/1207). Caso algo dê errado / não funcione, o repositório original do exemplo não está mais disponível no GitHub, mas os trechos acima já dão para começar.

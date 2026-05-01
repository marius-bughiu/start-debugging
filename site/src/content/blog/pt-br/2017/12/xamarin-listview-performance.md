---
title: "Performance do ListView do Xamarin e a substituição pelo Syncfusion SfListView"
description: "Melhore a performance de scroll do ListView do Xamarin Forms com estratégias de caching, otimização de templates e o Syncfusion SfListView."
pubDate: 2017-12-16
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2017/12/xamarin-listview-performance"
translatedBy: "claude"
translationDate: 2026-05-01
---
Embora o Xamarin venha adicionando recursos e melhorando a performance do Xamarin Forms a cada update, o que oferecem em controles de UI multiplataforma nem sempre é suficiente. No meu caso, tenho um app leitor de RSS que agrega notícias de várias fontes e as exibe em um ListView assim:

Eu gosto da aparência do app, mas ele tem um grande problema: performance. Mesmo em dispositivos top de linha o scroll fica lento, e em dispositivos mais fracos ele continua jogando OutOfMemory exceptions devido às imagens carregadas. Então, mudança era preciso. Neste artigo abordo só o primeiro -- a performance de scroll; as OutOfMemory exceptions ficam para outra hora.

### O Item template

A primeira coisa para olhar ao investigar performance é o ItemTemplate do ListView. Qualquer otimização nesse nível terá grande impacto na performance geral do ListView. Olhe coisas como:

-   reduzir a quantidade de elementos XAML. Quanto menos elementos para renderizar, melhor
-   o mesmo vale para aninhamento. Evite aninhar elementos e criar hierarquias profundas. A renderização vai ficar lentíssima
-   garanta que o seu ItemSource seja IList, não IEnumerable. IEnumerable não suporta acesso aleatório
-   não altere o layout com base no BindingContext. Use um DataTemplateSelector

Você já deve notar melhorias no scroll após essas mudanças. O próximo da lista é a estratégia de caching.

### Estratégia de caching

Por padrão o Xamarin usa a estratégia de caching RetainElement no Android e iOS, o que significa criar uma instância do ItemTemplate para cada item da lista. Mude a caching strategy do ListView para RecycleElement para reaproveitar containers que não estão mais visíveis em vez de criar novos elementos toda hora. Isso melhora a performance ao eliminar custos de inicialização.

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

Se por acaso você usa um DataTemplateSelector, então deve usar a estratégia RecycleElementAndDataTemplate. Para mais detalhes sobre estratégias de caching, confira a [documentação do Xamarin](https://learn.microsoft.com/en-us/xamarin/xamarin-forms/user-interface/listview/performance) sobre performance de ListView.

### Syncfusion ListView

Se você chegou até aqui e os problemas de performance não foram resolvidos, é hora de olhar outras opções. No meu caso, dei uma chance ao SfListView da Syncfusion porque eles são conhecidos pelas suítes de controles e oferecem os controles Xamarin de graça nas mesmas condições do Visual Studio Community (mais ou menos). Para começar, vá ao site da Syncfusion e [solicite sua licença community gratuita](https://www.syncfusion.com/products/communitylicense), se ainda não tiver.

Em seguida, adicione o pacote SfListView ao seu projeto. Os pacotes da Syncfusion ficam no repositório NuGet deles. Para acessá-lo, é preciso adicioná-lo às suas NuGet sources. Um guia completo de como fazer isso está [aqui](https://help.syncfusion.com/xamarin/listview/getting-started). Feito isso, uma busca simples por SfListView no NuGet vai trazer o pacote desejado. Instale o pacote no seu projeto core/cross-platform e em todos os projetos de plataforma também; ele vai pegar automaticamente as DLLs corretas conforme o target do projeto.

Agora que tudo está instalado, é hora de substituir o ListView padrão. Para isso, adicione o seguinte namespace na sua page/view:

```xml
xmlns:sflv="clr-namespace:Syncfusion.ListView.XForms;assembly=Syncfusion.SfListView.XForms"
```

Em seguida, troque a tag ListView por sflv:ListView, a ListView.ItemTemplate por sflv:SfListView.ItemTemplate e remova o ViewCell da hierarquia -- não é necessário. Além disso, se você estava usando a propriedade CachingStrategy, remova-a também -- o SfListView recicla elementos por padrão. Deve ficar parecido com isso:

```xml
<sflv:SfListView>
    <sflv:SfListView.ItemTemplate>
        <DataTemplate>
           ...
        </DataTemplate>
    </sflv:SfListView.ItemTemplate>
</sflv:SfListView>
```

É isso. Se tiver dúvidas, deixe nos comentários abaixo. E se tiver outras dicas para melhorar a performance do ListView, compartilhe.

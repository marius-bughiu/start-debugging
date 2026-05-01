---
title: "O que há de novo no .NET 8"
description: ".NET 8 foi lançado em 14 de novembro de 2023 como uma versão LTS (Long Term Support), o que significa que continuará recebendo suporte, atualizações e correções de bugs por pelo menos três anos a partir do lançamento. Como de costume, .NET 8 traz suporte a uma nova versão da linguagem C#, no caso C# 12."
pubDate: 2023-06-10
updatedDate: 2023-11-15
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/06/whats-new-in-net-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 foi lançado em **14 de novembro de 2023** como uma versão LTS (Long Term Support), o que significa que continuará recebendo suporte, atualizações e correções de bugs por pelo menos três anos a partir do lançamento.

Como de costume, .NET 8 traz suporte a uma nova versão da linguagem C#, no caso C# 12. Confira nossa página dedicada cobrindo [o que há de novo no C# 12](/2023/06/whats-new-in-c-12/).

Vamos mergulhar na lista de mudanças e novos recursos do .NET 8:

-   [.NET Aspire (preview)](/pt-br/2023/11/what-is-net-aspire/)
    -   [Pré-requisitos](/pt-br/2023/11/how-to-install-net-aspire/)
    -   [Como começar](/pt-br/2023/11/getting-started-with-net-aspire/)
-   Mudanças no SDK do .NET
    -   [Comando 'dotnet workload clean'](/pt-br/2023/09/dotnet-workload-clean/)
    -   Recursos de 'dotnet publish' e 'dotnet pack'
-   Serialização
    -   [Políticas de nomenclatura JSON snake\_case e kebab-case](/pt-br/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/)
    -   [Tratar membros ausentes durante a serialização](/pt-br/2023/09/net-8-handle-missing-members-during-json-deserialization/)
    -   [Desserializar em propriedades somente leitura](/pt-br/2023/09/net-8-deserialize-into-read-only-properties/)
    -   [Incluir propriedades não públicas na serialização](/pt-br/2023/09/net-8-include-non-public-members-in-json-serialization/)
    -   [Adicionar modificadores a instâncias existentes de IJsonTypeInfoResolver](/pt-br/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)
    -   Desserialização em streaming: [de JSON para AsyncEnumerable](/pt-br/2023/10/httpclient-get-json-as-asyncenumerable/)
    -   JsonNode: [deep clone, deep copy](/pt-br/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/) e [outras atualizações de API](/pt-br/2023/10/jsonnode-net-8-api-updates/)
    -   [Desativar a serialização padrão baseada em reflexão](/pt-br/2023/10/system-text-json-disable-reflection-based-serialization/)
    -   [Adicionar/Remover TypeInfoResolver em uma instância existente de JsonSerializerOptions](/pt-br/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/)
-   Bibliotecas principais do .NET
    -   [FrozenDictionary -- comparação de desempenho](/pt-br/2023/08/net-8-performance-dictionary-vs-frozendictionary/)
    -   Métodos para trabalhar com aleatoriedade -- [GetItems<T>()](/pt-br/2023/11/c-randomly-choose-items-from-a-list/) e [Shuffle<T>()](/pt-br/2023/10/c-how-to-shuffle-an-array/)
-   Bibliotecas de extensão
-   Coleta de lixo
-   Source generator para vinculação de configuração
-   Melhorias em reflexão
    -   Sem mais reflexão: conheça [UnsafeAccessorAttribute](/pt-br/2023/10/unsafe-accessor/) (veja os [benchmarks de desempenho](/pt-br/2023/11/net-8-performance-unsafeaccessor-vs-reflection/))
    -   [Atualizar campos `readonly`](/2023/06/whats-new-in-net-8/)
-   Suporte a Native AOT
-   Melhorias de desempenho
-   Imagens de container do .NET
-   .NET no Linux
-   Windows Presentation Foundation (WPF)
    -   [Aceleração por hardware no RDP](/pt-br/2023/10/wpf-hardware-acceleration-in-rdp/)
    -   [Diálogo Open Folder](/pt-br/2023/10/wpf-open-folder-dialog/)
        -   Opções adicionais do diálogo ([ClientGuid](/pt-br/2023/10/wpf-individual-dialog-states-using-clientguid/), [RootDirectory](/pt-br/2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder/), [AddToRecent](/pt-br/2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents/) e CreateTestFile)
-   NuGet

---
title: "Azure Functions vs WebJobs: qual escolher"
description: "Compare Azure Functions e WebJobs: diferenças-chave em escalonamento, preços, triggers e quando escolher um em vez do outro."
pubDate: 2020-11-18
updatedDate: 2021-02-19
tags:
  - "azure"
  - "azure-functions"
lang: "pt-br"
translationOf: "2020/11/azure-functions-vs-webjobs-which-to-choose"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ambos são tecnologias "code-first" voltadas a desenvolvedores ([ao contrário de serviços de workflow design-first](/pt-br/2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate/)). Eles permitem orquestrar e integrar diferentes aplicações de negócio em um único fluxo de trabalho e oferecem mais controle sobre o desempenho do seu workflow, além da capacidade de escrever código personalizado como parte do processo de negócio.

## Azure WebJobs

WebJobs são parte do Azure App Service e podem ser usados para executar um programa ou script automaticamente. Existem dois tipos de WebJob:

-   **Continuous.** Executam em loop contínuo. Por exemplo, você poderia usar um WebJob contínuo para verificar uma pasta compartilhada em busca de uma nova foto.
-   **Triggered.** Podem ser executados manualmente ou em um agendamento.

Para definir as ações do seu WebJob, você pode escrever código em várias linguagens diferentes. Por exemplo, é possível scriptar o WebJob escrevendo código em Shell Script (Windows, PowerShell, Bash). Como alternativa, você pode escrever um programa em PHP, Python, Node.js, JavaScript ou .NET, e em qualquer das linguagens suportadas pelo framework.

## Azure Functions

Uma Azure Function é, em muitos aspectos, semelhante a um WebJob; a principal diferença é que você não precisa se preocupar com a infraestrutura.

É ideal para executar pequenos trechos de código na nuvem. O Azure escalará automaticamente a sua função em resposta à demanda, e com o consumption plan você só paga pelo tempo em que seu código fica em execução.

Podem ser disparados por uma série de triggers diferentes, por exemplo:

-   **HTTPTrigger**. Executa em resposta a uma requisição enviada pelo protocolo HTTP.
-   **TimerTrigger**. Permite a execução de acordo com um agendamento.
-   **BlobTrigger**. Quando um novo blob é adicionado a uma conta do Azure Storage.
-   **CosmosDBTrigger**. Em resposta a documentos novos ou atualizados em um banco NoSQL.

## Diferenças

| Recurso | Azure WebJobs | Azure Functions |
| --- | --- | --- |
| Escalonamento automático | Não | Sim |
| Desenvolvimento e testes no navegador | Não | Sim |
| Preços pay-per-use | Não | Sim |
| Integração com Logic Apps | Não | Sim |
| Gerenciadores de pacotes | NuGet se você estiver usando o WebJobs SDK | NuGet e NPM |
| Pode fazer parte de uma aplicação App Service | Sim | Não |
| Oferece controle próximo de `JobHost` | Sim | Não |

## Conclusões

No geral, o Azure Functions é mais flexível e mais fácil de administrar. No entanto, os WebJobs são uma solução melhor quando:

-   Você quer que o código faça parte de uma aplicação App Service existente e seja gerenciado como parte dessa aplicação, por exemplo no mesmo ambiente do Azure DevOps.
-   Você precisa de controle próximo sobre o objeto que escuta os eventos que disparam o código.

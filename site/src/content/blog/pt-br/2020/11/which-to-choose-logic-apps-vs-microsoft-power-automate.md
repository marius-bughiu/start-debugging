---
title: "Qual escolher: Logic Apps vs Microsoft Power Automate"
description: "Compare o Azure Logic Apps e o Microsoft Power Automate para determinar qual serviço de automação de fluxos de trabalho se adapta melhor ao seu caso de uso."
pubDate: 2020-11-18
tags:
  - "azure"
  - "logic-apps"
  - "microsoft-power-automate"
lang: "pt-br"
translationOf: "2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ambos são tecnologias "design-first", ou seja, oferecem interfaces de usuário que permitem desenhar seus fluxos de trabalho em vez de programá-los. Outras semelhanças entre os dois:

-   Podem aceitar entradas
-   Podem executar ações
-   Podem controlar o fluxo de trabalho usando condições
-   Podem produzir saídas

## Logic Apps

Logic Apps é um serviço fornecido pelo Azure que você pode usar para automatizar, orquestrar e integrar componentes distintos de uma aplicação distribuída. Pelo Logic Apps, você pode desenhar fluxos de trabalho complexos que modelam processos de negócio complexos.

O Logic Apps também oferece uma visão de código que permite criar e editar fluxos de trabalho usando notação JSON.

É ideal para projetos de integração, já que o serviço fornece centenas de conectores diferentes para diversos apps e serviços externos. Além disso, você também pode criar seus próprios conectores personalizados com facilidade.

## Microsoft Power Automate

O Microsoft Power Automate é um serviço construído sobre o Logic Apps, voltado a pessoas sem experiência em desenvolvimento ou como IT Pro que desejam criar fluxos de trabalho. Você pode criar fluxos complexos integrando muitos componentes diferentes usando o site ou o app móvel do Microsoft Power Automate.

Existem quatro tipos diferentes de fluxos de trabalho:

-   **Automated**: um fluxo iniciado por um trigger. Por exemplo, o trigger pode ser a chegada de um novo tweet ou o upload de um novo arquivo.
-   **Button**: um fluxo que pode ser disparado manualmente pelo aplicativo móvel.
-   **Scheduled**: um fluxo que é executado regularmente.
-   **Business process**: um fluxo que modela um processo de negócio e pode incluir: notificação às pessoas necessárias com aprovação registrada; datas no calendário para as etapas; e tempo registrado das etapas do fluxo.

Em termos de conectores, o Microsoft Power Automate tem exatamente os mesmos do Logic Apps, incluindo a possibilidade de criar e usar conectores personalizados.

## Diferenças

| | Microsoft Power Automate | Logic Apps |
| --- | --- | --- |
| **Usuários-alvo** | Trabalhadores de escritório e analistas de negócio | Desenvolvedores e IT pros |
| **Cenários-alvo** | Criação self-service de fluxos | Projetos avançados de integração |
| **Ferramentas de design** | Somente GUI. Navegador e app móvel | Designer no navegador e no Visual Studio. É possível editar código usando JSON |
| **Application Lifecycle Management** | O Power Automate inclui ambientes de teste e produção | O código-fonte do Logic Apps pode ser incluído no Azure DevOps e em sistemas de controle de código-fonte |

## Conclusões

Os dois serviços são bem parecidos, sendo a principal diferença o público-alvo: o Microsoft Power Automate é voltado a pessoas não técnicas, enquanto o Logic Apps se aproxima mais de profissionais de IT, desenvolvedores e praticantes de DevOps.

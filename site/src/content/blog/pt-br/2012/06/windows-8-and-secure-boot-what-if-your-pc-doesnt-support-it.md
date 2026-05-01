---
title: "Windows 8 e Secure Boot: e se o seu PC não suportar?"
description: "O que fazer quando aparece o erro 'Secure Boot isn't compatible with your PC' ao instalar o Windows 8 e o que é realmente o Secure Boot."
pubDate: 2012-06-05
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "pt-br"
translationOf: "2012/06/windows-8-and-secure-boot-what-if-your-pc-doesnt-support-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hoje, enquanto (por engano) tentava atualizar meu Windows 7 para Windows 8, esbarrei em uma checagem de compatibilidade com 6 erros, incluindo um que diz:

> Secure Boot isn't compatible with your PC

A princípio fiquei meio assustado, achando que não conseguiria instalar o Windows 8, embora a Consumer Preview tenha rodado bem (com algumas exceções), mas depois de algumas pesquisas percebi que isso não será problema algum. O Secure Boot é um recurso que você pode simplesmente pular e tudo vai funcionar normalmente.

**Mas o que é exatamente o Secure Boot?**

O Secure Boot é um novo processo de boot (measured boot) que, em conjunto com o UEFI 2.3.1 (Unified Extensible Firmware Interface), endereça uma brecha de segurança presente no design atual do BIOS que permite que softwares maliciosos sejam carregados antes do sistema operacional. Isso é feito por meio de certificados -- basicamente, nada será carregado a menos que esteja assinado pela Microsoft, ou seja, sem malware.

Esse recurso está disponível apenas em sistemas relativamente novos, porque depende de um chip chamado Trusted Platform Module ou TPM. Esse chip é usado para armazenar os processos de inicialização assinados, protegidos e medidos nos quais o Secure Boot se baseia.

Então sem TPM -- sem Secure Boot, apenas o boot normal -- ou seja, isso não vai impedir você de instalar o Windows 8 na sua máquina.

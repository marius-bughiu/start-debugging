---
title: "Como instalar o Windows 8 usando um pendrive"
description: "Guia passo a passo para instalar o Windows 8 a partir de um pendrive usando a Windows 7 USB/DVD Download Tool, com dicas de formatação, configuração de BIOS e troubleshooting."
pubDate: 2012-02-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "pt-br"
translationOf: "2012/02/how-to-install-windows-8-using-a-usb-drive"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para começar, você vai precisar de uma imagem ISO do Windows 8 e da Windows 7 USB / DVD Download Tool, que vai ajudar a colocar essa imagem no pendrive. Você pode baixar ambos clicando nas respectivas imagens abaixo.

[![Windows 8 Developer Preview 64bit](https://lh6.googleusercontent.com/-mq-MQd8BRhI/TylZRYlL90I/AAAAAAAAADU/8EBFMLQqkiw/s257/Windows%25208%2520Developer%2520Preview%252064bit.PNG)](http://msdn.microsoft.com/en-us/windows/apps/br229516)

[![Windows USB Tool](https://lh3.googleusercontent.com/-RTG-V-mR--I/TylZRp6bKsI/AAAAAAAAADQ/CLxQ1-cwuis/s256/Windows%2520USB%2520DVD%2520Tool.PNG)](https://go.microsoft.com/fwlink/?LinkId=691209)

Instale a Windows 7 USB Tool quando o download terminar. Não se preocupe com o nome dizer Windows 7, ela funciona muito bem com o Windows 8 também.

Agora que você tem todos os arquivos necessários, conecte o pendrive no PC, clique nele com o botão direito e selecione format. A maioria dos tutoriais que vi diz para formatar como FAT32, caso contrário não funciona -- só que, quando uso a ferramenta para copiar os arquivos do Windows para o pendrive, ela mesma formata como NTFS. Estranho, mas tudo bem.

[![Windows Format Window](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)

Faça um quick format como FAT32 e **não esqueça de fazer backup dos seus dados!**

Pendrive formatado, abra a Windows 7 USB Tool, clique em **Browse** e selecione a imagem ISO que você acabou de baixar.

[![Windows USB Tool Choose an ISO File](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)

Clique em **Next** e, na próxima tela em que ela pede para escolher o tipo de mídia, selecione **USB device**. Como você pode ver, há também a opção de gravar a imagem direto em um DVD. Para este how-to vamos ficar com o pendrive.

[![Windows USB Tool Choose Media Type](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)

Escolha o pendrive em que a ferramenta deve gravar os arquivos de instalação e clique em **Begin copying.**

[![Windows USB Tool Choose USB Drive](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)

A ferramenta vai começar a copiar os arquivos de instalação do Windows para o pendrive.

[![Windows USB Tool Copying Files](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)

Quando o processo todo terminar, e se não tiverem ocorrido erros, reinicie o computador, abra o menu de boot (F12 no meu caso, durante o POST) e selecione o pendrive. Se ele não aparecer nessa lista, entre na BIOS e confirme que **Legacy USB Support** está **Enabled**.

**Observações:**

-   Você não consegue criar um pendrive bootável com Windows 64-bit se estiver rodando um sistema operacional de 32-bit. Você precisa de um sistema operacional 64-bit para criar um pendrive bootável com Windows 64-bit.
-   O pendrive precisa ser grande o suficiente. 4 GB serve para as versões 32-bit e 64-bit simples, mas para a versão 64-bit que inclui as developer tools você vai precisar de um pendrive de 8 GB, já que só a ISO tem 4.7 GB.
-   Faça backup dos dados do pendrive antes de formatar. Caso contrário, eles se perdem. Além disso, escolha com cuidado a partição em que vai instalar o SO para não sobrescrever sua instalação atual do Windows por engano -- nesse caso também todos os dados serão perdidos.

Por último: publicado de uma instalação nova do Windows 8. Para você ter certeza de que funciona.

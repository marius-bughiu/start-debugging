---
title: "Use seu celular Android como webcam no Streamlabs"
description: "Use um Android como webcam no Streamlabs Desktop para Windows, com downloads atuais do DroidCam e capturas clássicas identificadas."
pubDate: 2019-04-30
updatedDate: 2026-11-02
tags:
  - "android"
lang: "pt-br"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---

Um Android com câmera funcionando pode fornecer vídeo para uma cena do Streamlabs. A qualidade depende do aparelho, iluminação, conexão e ajustes; um celular antigo não é automaticamente melhor que uma webcam dedicada.

## Escolher o app e o cliente correspondentes

As capturas mostram **DroidCam Classic e a interface antiga do Streamlabs OBS no Windows**. O pacote Android original, `com.dev47apps.droidcam`, retornou 404 em verificações com parâmetros regionais do Google Play dos EUA, Romênia e Alemanha em 2 de novembro de 2026. Isso não prova remoção mundial nem a disponibilidade para todas as contas ou aparelhos existentes.

Para instalações novas, [droidcam.app](https://droidcam.app/) atualmente aponta para [DroidCam Webcam & OBS Camera da Dev47Apps](https://play.google.com/store/apps/details?id=com.dev47apps.obsdroidcam), pacote `com.dev47apps.obsdroidcam`. É outro app Android, não um link renomeado para o clássico. As [FAQ oficiais](https://droidcam.app/help/) distinguem app/cliente novos dos clássicos. Use o par correspondente; as capturas clássicas não explicam a interface nova.

Este procedimento é para **Windows**. O [cliente atual DroidCam](https://droidcam.app/windows/) suporta Windows 10/11, mas sua versão do Streamlabs também precisa cumprir os [próprios requisitos](https://streamlabs.com/content-hub/post/streamlabs-desktop-system-requirements). A existência de cliente DroidCam para Linux não transforma isto em tutorial do Streamlabs Desktop para Linux. Configurações macOS e com plugin OBS Studio são outras; um plugin OBS Studio não equivale a uma fonte Streamlabs.

## Configuração atual no Windows

1. Instale o app Android atual da Dev47Apps pelo link verificado e conceda acesso à câmera. Ative o microfone apenas se quiser usar o áudio do celular.
2. Instale o cliente Windows correspondente pela [página oficial de download/configuração](https://droidcam.app/windows/).
3. Conecte celular e computador à mesma rede. Abra o app e, no cliente, escolha **Add > DroidCam**, atualize a lista e conecte o celular. Para USB ou falhas na descoberta, consulte a ajuda oficial.
4. Reabra o Streamlabs Desktop após instalar o driver. Seguindo o [guia de fontes](https://streamlabs.com/content-hub/post/quick-start-guide-setting-up-streamlabs-desktop-for-streaming), adicione **Video Capture Device** e selecione a câmera exposta pelo cliente. O guia Windows atual a chama **DroidCam Video**; o Classic pode mostrar **DroidCam Source 2/3**.
5. Confira a prévia, ajuste a fonte na cena e faça uma gravação curta de teste. Verifique o áudio separadamente; vídeo funcionando não garante o roteamento correto do microfone.

## Procedimento clássico no Windows: capturas arquivadas

As imagens preservam o procedimento original para quem já tem app e cliente Classic correspondentes. O [guia clássico de conexão](https://www.dev47apps.com/droidcam/connect/) usa a mesma rede e o IP Wi-Fi/porta exibidos no celular. Os downloads continuam documentados na [página do cliente clássico Windows](https://www.dev47apps.com/droidcam/windows/).

O app Android clássico exibe o endereço de conexão.

![DroidCam no Android mostra o endereço IP do Wi-Fi e a porta para conectar o cliente de desktop.](/wp-content/uploads/2019/04/image-7.png)

Informe endereço e porta no cliente clássico Windows.

![Janela de conexão Wi-Fi do DroidCam Client com IP e porta preenchidos e Video e Audio ativados.](/wp-content/uploads/2019/04/image-8.png)

Inicie a conexão e confira a prévia da câmera.

![DroidCam Client exibe a imagem da câmera do telefone conectado.](/wp-content/uploads/2019/04/image-9.png)

A interface antiga do Streamlabs adiciona uma fonte Video Capture Device.

![Janela Add Source do Streamlabs com Video Capture Device sublinhado.](/wp-content/uploads/2019/04/image-5-1024x555.png)

Esta instalação usava DroidCam Source 3; escolha o dispositivo exposto pelo seu cliente.

![Configurações de Video Capture Device no Streamlabs com DroidCam Source 3 selecionado e prévia da câmera.](/wp-content/uploads/2019/04/image-10.png)

Posicione e redimensione a câmera dentro da cena.

![Cena do Streamlabs com a câmera do telefone em uma pequena sobreposição no canto inferior direito da captura de tela.](/wp-content/uploads/2019/04/image-11-1024x555.png)

Um suporte estável próximo à altura dos olhos facilita o enquadramento. Escolha um compatível com o aparelho; a menção antiga ao Huawei AF14 era uma compra pessoal, não uma recomendação atual de preço ou disponibilidade.

Para outro elemento da cena, veja o [tutorial de enquetes do Streamlabs](/pt-br/2020/08/polls-for-streamlabs-interact-with-your-viewers/).

**Correção em 2 de novembro de 2026:** separados DroidCam Classic e atual, substituído o link clássico indisponível por instruções atuais identificadas e limitado o procedimento Streamlabs ao Windows. Links e instruções oficiais foram verificados; não houve teste físico com celular e Windows nesta atualização.

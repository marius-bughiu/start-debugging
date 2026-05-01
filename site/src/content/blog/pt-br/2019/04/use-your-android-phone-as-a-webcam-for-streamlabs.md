---
title: "Use seu celular Android como webcam no Streamlabs"
description: "Transforme seu celular Android antigo em uma webcam para o Streamlabs OBS usando o DroidCam, com instruções passo a passo."
pubDate: 2019-04-30
updatedDate: 2020-08-06
tags:
  - "android"
lang: "pt-br"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---
Precisa de uma webcam para fazer streaming? Por que não usar um daqueles celulares quebrados ou desatualizados que você tem em casa?

A maioria dos celulares consegue tirar fotos e gravar em uma resolução mais alta e com qualidade melhor do que a webcam comum. Isso os torna um substituto ideal para webcam em transmissões, especialmente quando você tem um parado em casa.

Recentemente fiquei com um Google Pixel 2 XL com a tela com defeito. Resumindo: rachei a tela, troquei e 8 meses depois a tela de reposição falhou. Pelo custo e pela falta de garantia, decidi parar por aí e não trocar a tela de novo. Então fiquei com um smartphone defeituoso, mas com uma câmera ótima funcionando perfeitamente.

Vamos ao que interessa. Para usar seu celular Android como webcam você vai precisar de duas coisas:

-   [DroidCam Wireless Webcam](https://play.google.com/store/apps/details?id=com.dev47apps.droidcam) para Android
-   e o aplicativo cliente para Windows ou Linux, que você pode [baixar aqui](http://www.dev47apps.com/)

Primeiro, baixe e instale o app no celular Android. Após instalar, passe pelo assistente de configuração, conceda as permissões necessárias (gravar áudio e vídeo) e pronto. Agora o app deve mostrar informações como o endereço IP e a porta em que está transmitindo o vídeo. Deixe à mão, vamos precisar no próximo passo.

![](/wp-content/uploads/2019/04/image-7.png)

Em seguida, baixe e instale o cliente para Windows ou Linux. Após a instalação, abra o app e preencha o endereço IP e a porta exatamente como aparecem no aplicativo Android.

![](/wp-content/uploads/2019/04/image-8.png)

Quando estiver pronto, clique em Start. E voilà, sua nova webcam!

![](/wp-content/uploads/2019/04/image-9.png)

O último passo é adicionar a fonte de vídeo no Streamlabs. Abra o Streamlabs OBS e clique em + para adicionar uma nova Source.

![](/wp-content/uploads/2019/04/image-5-1024x555.png)

No popup que se abre, selecione Video Capture Device e clique em Add Source. Na próxima tela, clique em Add New Source. Agora você pode mexer nas configurações do dispositivo. Primeiro, selecione o DroidCam no dropdown Device; no meu caso aparece como DroidCam Source. Em seguida, brinque com os ajustes até obter o resultado desejado; para mim os padrões funcionaram bem. Quando terminar, clique em Done.

![](/wp-content/uploads/2019/04/image-10.png)

Agora você pode arrastar a fonte de vídeo pela sua cena e redimensionar como quiser. Quando estiver pronto, pode começar a transmitir.

![](/wp-content/uploads/2019/04/image-11-1024x555.png)

## Dica

Um dos problemas ao usar celulares como webcam é mantê-los em uma posição estável, de preferência em uma certa altura e ângulo. Você pode resolver isso com um tripé para smartphone.

Acabei optando por um Huawei AF14 por ser a opção mais barata que atendia às minhas necessidades. Depois de ter o tripé, posicione em um ângulo que combine com você e em uma altura próxima à do seu olhar.

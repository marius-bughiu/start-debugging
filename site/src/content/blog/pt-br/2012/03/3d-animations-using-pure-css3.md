---
title: "Animações 3D usando apenas CSS3"
description: "Aprenda a criar animações 3D apenas com CSS3, usando perspective e transitions de transform, com suporte cross-browser para WebKit e Firefox."
pubDate: 2012-03-04
updatedDate: 2023-11-05
tags:
  - "css"
lang: "pt-br"
translationOf: "2012/03/3d-animations-using-pure-css3"
translatedBy: "claude"
translationDate: 2026-05-01
---
O que me inspirou a escrever este post e alguns outros foi [esta página](http://demo.marcofolio.net/3d_animation_css3/ "CSS3 3D Animations") (funciona apenas no Chrome e Safari). É impressionante o que dá para fazer só com CSS. Vamos olhar por baixo do capô -- o CSS desse efeito é assim:

```css
#movieposters li { 
    display:inline; float:left;
    -webkit-perspective: 500; -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective; -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover { 
    -webkit-perspective: 5000; 
}

#movieposters li img { 
    border:10px solid #fcfafa; 
    -webkit-transform: rotateY(30deg);
    -moz-box-shadow:0 3px 10px #888; 
    -webkit-box-shadow:0 3px 10px #888;
    -webkit-transition-property: transform; 
    -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover img { 
    -webkit-transform: rotateY(0deg); 
}
```

Meio bagunçado. Mas se tirarmos os borders e shadows e organizarmos um pouco o código, dá para ver que não é tão complicado.

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
}
```

Como você pode ver, o que está sendo feito são basicamente duas transitions:

-   uma transition de perspective no list item, de 500 para 5000 no hover, com duração de 0.5s
-   e uma transition de transform de rotação na imagem dentro do list item, com a mesma duração, de 30 graus para 0

Você pode brincar com os valores e ver que outros efeitos legais consegue. Quem sabe deixe um comentário com um link para o efeito que conseguir.

## Fazendo funcionar no Firefox

Agora, o que realmente me intrigou foi o fato de não funcionar no Firefox. Por quê? Após algumas pesquisas no Google a resposta ficou óbvia: os comandos -webkit- são para navegadores baseados em webkit, enquanto o Firefox exige comandos com prefixo -moz-. Acho que eu já deveria saber disso...

Então adicionei novas linhas para cada comando e troquei -webkit- por -moz-, achando que ia funcionar. Funcionou, exceto pelo fato de não ter animação. Algumas pesquisas depois e ainda sem resposta, então no verdadeiro espírito de dev abri o stackoverflow.com e fiz minha pergunta. Algumas horas depois eu tinha minha primeira resposta e, felizmente, ela trazia a solução do meu problema ([dê uma olhada aqui se quiser](http://stackoverflow.com/questions/9549624/moz-transition-duration-not-working "Firefox Transitions not working")). A transition-property também precisava ser uma propriedade -moz-. Propriedades simples como transform ou perspective não funcionam como no webkit, então tive que usar -moz-transform e -moz-perspective no lugar.

Eis então o código CSS completo que acabei usando:

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-perspective: 500;
    -moz-transform-style: preserve-3d;
    -moz-transition-property: -moz-perspective;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
    -moz-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-transform: rotateY(30deg);
    -moz-transition-property: -moz-transform;
    width: 210px;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
    -moz-transform: rotateY(0deg);
}
```

Também dá para conferir uma demo aqui: [3D CSS Animation](http://startdebugging.net/demos/3dcssanimation.html "3D CSS Animation")

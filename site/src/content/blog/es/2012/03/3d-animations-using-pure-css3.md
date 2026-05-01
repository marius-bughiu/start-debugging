---
title: "Animaciones 3D usando solo CSS3"
description: "Aprende a crear animaciones 3D usando solo CSS3 con perspective y transform transitions, con soporte multinavegador para WebKit y Firefox."
pubDate: 2012-03-04
updatedDate: 2023-11-05
tags:
  - "css"
lang: "es"
translationOf: "2012/03/3d-animations-using-pure-css3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Lo que me inspiró a escribir este post y algunos otros fue [esta página](http://demo.marcofolio.net/3d_animation_css3/ "CSS3 3D Animations") (funciona solo en Chrome y Safari). Es asombroso lo que se puede hacer usando solo CSS. Veamos cómo está hecho por dentro: el CSS de ese efecto se ve así:

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

Algo desordenado. Pero si quitamos los borders y shadows y reorganizamos el código un poco, verás que en realidad no es tan complicado.

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

Como puedes ver, lo que se hace son básicamente dos transiciones:

-   una transición de perspective sobre el list item, de un valor 500 a 5000 en hover, con duración de 0.5s
-   y una transición de transform de rotación sobre la imagen dentro del list item, con la misma duración, de 30 grados a 0 grados

Puedes jugar con los valores y ver qué otros efectos chulos puedes obtener. Quizá incluso dejar un comentario con un enlace al efecto que hayas conseguido.

## Hacer que funcione en Firefox

Lo que realmente me intrigó fue que esto no funcionara en Firefox. ¿Por qué? Tras unas cuantas búsquedas en Google la respuesta se hizo evidente: los comandos -webkit- son para navegadores basados en webkit, mientras que Firefox requiere comandos con prefijo -moz-. Supongo que ya debería haberlo sabido...

Así que añadí nuevas líneas para cada comando y reemplacé -webkit- por -moz- pensando que funcionaría. Y funcionó, salvo que no había animación. Un par de búsquedas después y aún sin respuesta, así que en el verdadero espíritu de un developer escribí stackoverflow.com e hice mi pregunta. Un par de horas más tarde tenía mi primera respuesta y, por suerte, contenía la solución a mi problema ([compruébalo aquí si quieres](http://stackoverflow.com/questions/9549624/moz-transition-duration-not-working "Firefox Transitions not working")). La propiedad transition-property también tenía que ser una propiedad -moz-. Propiedades simples como transform o perspective no funcionan como en webkit, así que tuve que usar -moz-transform y -moz-perspective.

Aquí tienes el código CSS completo que terminé usando:

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

También puedes ver una demo aquí: [3D CSS Animation](http://startdebugging.net/demos/3dcssanimation.html "3D CSS Animation")

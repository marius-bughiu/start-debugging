---
title: "3D-анимации только на CSS3"
description: "Узнайте, как создавать 3D-анимации только средствами CSS3 - perspective и transform-transitions, с поддержкой WebKit и Firefox."
pubDate: 2012-03-04
updatedDate: 2023-11-05
tags:
  - "css"
lang: "ru"
translationOf: "2012/03/3d-animations-using-pure-css3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Что вдохновило меня написать этот пост и ещё несколько других - это [эта страница](http://demo.marcofolio.net/3d_animation_css3/ "CSS3 3D Animations") (работает только в Chrome и Safari). Удивительно, чего можно добиться только средствами CSS. Заглянем под капот - CSS этого эффекта выглядит так:

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

Несколько громоздко. Но если убрать borders и shadows и немного причесать код, видно, что всё не так уж сложно.

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

Как видите, по сути выполняются два перехода:

-   переход perspective на list item с 500 на 5000 при hover, длительность 0.5s
-   и transform-переход поворота на изображении внутри list item, той же длительности, с 30 градусов на 0

Поэкспериментируйте со значениями и посмотрите, какие ещё интересные эффекты можно получить. Можете оставить комментарий со ссылкой на классный эффект, который у вас вышел.

## Как заставить это работать в Firefox

По-настоящему заинтриговало то, что в Firefox это не работает. Почему? Несколько поисков в Google - и ответ стал очевиден: команды -webkit- - для браузеров на webkit, а Firefox требует префикс -moz-. Наверное, я и так должен был это знать...

Я добавил по новой строке для каждой команды и заменил -webkit- на -moz-, рассчитывая, что заработает. И заработало - вот только без анимации. Ещё пара поисков и без ответа - так что в подлинном духе разработчика я зашёл на stackoverflow.com и задал вопрос. Через пару часов получил первый ответ, и, к счастью, в нём было решение моей проблемы ([можно посмотреть здесь](http://stackoverflow.com/questions/9549624/moz-transition-duration-not-working "Firefox Transitions not working")). transition-property тоже должна быть -moz--свойством. Простые свойства вроде transform или perspective работают не так, как в webkit, поэтому пришлось использовать -moz-transform и -moz-perspective.

Вот итоговый CSS, к которому я пришёл:

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

А посмотреть демо можно здесь: [3D CSS Animation](http://startdebugging.net/demos/3dcssanimation.html "3D CSS Animation")

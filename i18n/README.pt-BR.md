<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme/banner-dark.svg">
    <img src="../assets/readme/banner.svg" width="880" alt="Banner do popcornpals: cortinas de veludo se abrem para Rocco e Pip, dois guaxinins dividindo pipoca num sofá de cinema">
  </picture>
</p>

<h1 align="center">popcornpals</h1>

<p align="center">Assista ao mesmo vídeo no mesmo instante com até 4 amigos, com chat, voz e câmeras. Ponto a ponto, sem conta.</p>

<p align="center">
  <a href="https://kwy404.github.io/popcornpals/app/"><b>Abrir o app</b></a> &middot;
  <a href="https://kwy404.github.io/popcornpals/">Site</a> &middot;
  <a href="../README.md">English</a>
</p>

O popcornpals é uma sessão de cinema em grupo que roda inteira no navegador. Você cria uma sala, passa seis palavras para os amigos e aperta play: tocar, pausar, pular e a velocidade ficam iguais em todas as telas. Vídeo, voz e chat vão direto entre os navegadores por WebRTC. Não existe servidor nosso no meio e nada para cadastrar.

## Começo rápido

1. Abra **[kwy404.github.io/popcornpals/app](https://kwy404.github.io/popcornpals/app/)**, digite seu nome e toque em **Criar uma sala**.
2. Toque em **Convidar amigos**. Seu amigo pode digitar as seis palavras, escanear o código QR ou abrir o link de convite. Os três levam as mesmas palavras.
3. Seu amigo lê seis palavras de confirmação para você. Digite e a porta se abre.
4. Escolha o que assistir.

## O que dá para assistir

- **Seu próprio arquivo de vídeo.** O anfitrião escolhe um arquivo local e ele é transmitido do aparelho dele para todos. Os convidados não escolhem nada. A qualidade depende da velocidade de upload do anfitrião, dividida entre os convidados.
- **Modo melhor qualidade.** Quando todos já têm o mesmo arquivo, cada um abre a própria cópia. Uma impressão digital rápida confere se os arquivos são iguais, e só as mensagens de sincronia trafegam.
- **Legendas** em .srt ou .vtt para todos.
- **Vídeos do YouTube** no player oficial incorporado, com tocar, pausar, pular e velocidade em sincronia.
- **Compartilhar a tela**: uma aba, uma janela ou a tela inteira.
- **Sites de streaming, com a extensão opcional.** Ela toca, pausa e pula o player de cada pessoa, logada na própria conta. Nunca captura, grava ou retransmite vídeo e nunca mexe em proteção contra cópia.

## Juntos na sala

- **Chat** com respostas, reações e horários como 1:24:07 que levam todos para aquele momento.
- **Voz** para todos, com silenciar.
- **Supressão de ruído**: a do navegador e um modo Forte com nosso próprio processamento num AudioWorklet.
- **Câmeras** como pequenas poltronas embaixo da tela.
- **Escolha de dispositivos** para microfone, câmera e alto-falantes, nos Ajustes.

## Privacidade e limites

- Nenhum servidor nosso vê seu vídeo, sua voz ou suas mensagens.
- O WebRTC criptografa toda conexão com DTLS. As seis palavras se encontram em relays MQTT públicos, criptografadas com uma chave feita das palavras. No link de convite as palavras ficam depois do `#`, parte que o navegador nunca envia a servidor nenhum.
- Cada convite vale uma vez, por 10 minutos, e o anfitrião sempre digita as palavras de confirmação.
- Até 5 pessoas por sala.
- Muitos serviços de streaming bloqueiam a captura de vídeo protegido, então a tela compartilhada fica preta. Compartilhar nunca substitui uma assinatura.
- Em redes muito restritas a conexão direta pode falhar. Adicione seu próprio servidor TURN nos Ajustes.

## Autor

Feito por **Alexandre Kohler** ([GitHub](https://github.com/kwy404), [LinkedIn](https://www.linkedin.com/in/alexandre-silva-173687256/)).

## Licença

[MIT](../LICENSE) 2026 Alexandre Kohler

#!/bin/bash
# Atalho para iniciar o LexFlow no Mac.
# Dê dois cliques neste arquivo (ou clique com o botão direito > Abrir na 1ª vez).

cd "$(dirname "$0")" || exit 1
clear
echo "==================================================="
echo "            LexFlow — iniciando o sistema"
echo "==================================================="
echo ""

# 1) Verifica se o Node.js está instalado.
if ! command -v node >/dev/null 2>&1; then
  echo ">> O programa Node.js ainda nao esta instalado."
  echo ""
  echo "   1. Acesse:  https://nodejs.org"
  echo "   2. Baixe o botao verde 'LTS' e instale (clique em Continuar/Concordar)."
  echo "   3. Feche e abra este atalho 'Iniciar LexFlow' de novo."
  echo ""
  read -r -p "Pressione Enter para fechar..."
  exit 1
fi

# 2) Na primeira vez, prepara as dependencias.
if [ ! -d node_modules ]; then
  echo ">> Preparando o sistema pela primeira vez (pode levar 1 a 2 minutos)..."
  echo ""
  if ! npm install; then
    echo ""
    echo ">> Algo deu errado ao preparar. Verifique sua internet e tente de novo."
    read -r -p "Pressione Enter para fechar..."
    exit 1
  fi
fi

# 3) Abre o navegador e inicia o servidor.
echo ""
echo ">> Abrindo no seu navegador: http://localhost:3000"
echo ">> Para PARAR o sistema depois, basta FECHAR esta janela preta."
echo ""
( sleep 2 && open "http://localhost:3000" ) &
node server.js

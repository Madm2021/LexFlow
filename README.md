# LexFlow

Sistema web para **subir, importar e unificar planilhas** em uma **base única**,
com **busca e filtros instantâneos**, **higienização de CPF/datas** e
**distribuição (contagens) por valor**. Você arrasta seus arquivos `.xlsx` /
`.csv`, o LexFlow mapeia as colunas para um conjunto **pré-definido** de campos
(CPF, Nome, Estado, Município, CID, Data de nascimento, etc.), junta tudo numa
só tabela, **ignora linhas duplicadas** e permite pesquisar, filtrar, ver
distribuições e exportar.

> **Foco**: armazenar e consultar. É só isso — sem jurimetria, sem pontuação,
> sem triagem. Simples e rápido, mesmo com **milhões de linhas** (a base de
> produção tem ~11,3 milhões de registros) e dentro de uma máquina com RAM
> limitada (~24 GB), sem travar.

## Principais recursos

- **Base única**: todas as planilhas alimentam uma só tabela, com a coluna
  *Origem* indicando de qual arquivo veio cada linha.
- **Colunas pré-definidas (de-para)**: layouts diferentes são unificados nas
  mesmas colunas. O mapeamento fica em `mapping.js`.
- **Busca full-text instantânea (FTS5)**: pesquise por nome, cidade, CID ou
  **CPF (com ou sem pontuação)** em qualquer lugar da base — sem varrer tudo.
- **Filtros por coluna**: Estado (dropdown, UF normalizada), Município (começa
  com…), CID-10, todos instantâneos. Mais o filtro **"Apenas CPF válido"**.
- **Higienização (uma vez + automática na importação)**:
  - **CPF**: tira o `.0` do Excel, **recupera o zero à esquerda** (`padStart`),
    valida o **dígito verificador** e marca cada linha como válida/inválida.
    Linhas inválidas continuam na base, apenas sinalizadas.
  - **Datas**: converte o **serial do Excel** (ex.: `40636 → 03/04/2011`) e
    normaliza para `dd/mm/aaaa`.
  - Roda **uma vez** em segundo plano, em lotes com pausa — **não trava** o site
    nem estoura a memória. Planilhas novas já entram higienizadas no import.
- **Distribuição (facetas)**: contagens por **Estado**, **Top Municípios** e
  **Top CID-10**, sempre respeitando o filtro atual. Calculada numa **thread de
  trabalho (worker)** + **cache persistente** — não congela o servidor e abre
  instantânea depois do primeiro cálculo. Exporta a contagem em CSV.
- **Deduplicação por identidade + enriquecimento**: cada registro recebe uma
  **chave flexível** (`_key`) — usa a **CAT** quando existe; senão o **CPF**
  válido; senão cai no `_hash` (linha idêntica). Ao importar, se a pessoa/caso
  já existe, o sistema **não duplica** e ainda **complementa os campos vazios**
  com o que vier de novo (telefone, e-mail, endereço). Campos de contato com
  valores diferentes são **acumulados** (`1111 / 2222`, sem repetir); campos de
  identidade (nome, CPF) são mantidos. A chave dos registros já existentes é
  preenchida pela **higienização** (não apaga nada).
- **Upload por arrastar-e-soltar**, vários arquivos por vez (`.xlsx`, `.xlsm`, `.csv`).
- **Importação em streaming**: arquivos grandes (milhões de linhas) são lidos em
  lotes, com baixo uso de memória.
- **Exportação** para CSV (tudo ou só o resultado da busca/filtro), em streaming.
- **Tema claro/escuro** (botão) e **layout fluido** que ocupa a tela toda
  (responsivo: celular, tablet, desktop).
- **Banco único** em SQLite (padrão `data/lexflow.db`).

## Como rodar

Pré-requisito: Node.js 18+.

```bash
npm install
npm start
```

Abra <http://localhost:3000> no navegador.

Para desenvolvimento (recarrega ao salvar): `npm run dev`.

### Variáveis de ambiente

- `PORT` — porta do servidor (padrão `3000`).
- `LEXFLOW_DB` — caminho do arquivo SQLite (em produção: `/data/lexflow.db`, no
  volume da Railway).
- `LEXFLOW_PASSWORD` — se definida, exige senha para acessar (tela de login).
  Sem ela, o acesso é livre (uso local). **Defina ao publicar na web.**
- `LEXFLOW_SECRET` — (opcional) segredo para assinar o cookie de sessão.

## Operação no dia a dia

1. **Importar uma planilha nova**: clique em **⤓ Importar**, arraste o(s)
   arquivo(s). Linhas repetidas são ignoradas; o CPF e as datas já entram
   higienizados.
2. **Higienizar a base inteira** (só na 1ª vez, ou após importar dados antigos
   que ainda não passaram): no modal de Importar, **🧼 Higienizar agora**. Roda
   em segundo plano; pode fechar o navegador que continua no servidor.
3. **Prospectar**: ligue **"Apenas CPF válido"** e refine por Estado / Município
   / CID-10. Use **📊 Distribuição** para ver os volumes do recorte e
   **⤒ Exportar** para baixar só o que está filtrado.

## Deploy (Railway)

Produção roda na **Railway**, com deploy automático a partir do branch `main`.
O banco fica num **volume persistente** montado em `/data`
(`LEXFLOW_DB=/data/lexflow.db`), então sobrevive a redeploys. Defina
`LEXFLOW_PASSWORD` nas variáveis do serviço para proteger o acesso.

> O arquivo `render.yaml` é legado (deploy anterior no Render) e não é usado.

## Migração automática da base antiga

Se havia uma base no formato antigo (schema "largo" + jurimetria), o LexFlow
**migra automaticamente** na primeira subida com este código: mapeia as colunas
para o novo formato enxuto, preserva o histórico (e o `_hash` de dedup) e
descarta as colunas de pontuação. É feito numa transação (se falhar, nada muda).
Não roda `VACUUM` automático (lento em bases de milhões de linhas); as páginas
liberadas ficam reutilizáveis dentro do próprio arquivo.

## Como funciona por baixo

Todas as planilhas alimentam uma única tabela `records` com **colunas fixas** (as
de `mapping.js`/`schema.js`). Cada linha recebe um `_hash` com índice único; a
inserção usa `INSERT OR IGNORE`, então linhas idênticas são descartadas. Além
disso, cada registro tem uma **chave de identidade** `_key` (CAT, ou CPF
válido; ver `recordKey` em `hygiene.js`) com índice não-único: no import, se a
chave já existe, o registro é **fundido** (`mergeIntoExisting` em `store.js`) em
vez de inserido — preenchendo vazios e acumulando contatos. Um
índice **FTS5** (`records_fts`, *external content* + triggers) sobre um texto
concatenado (`_search`) dá a busca instantânea; índices `COLLATE NOCASE` nas
colunas de filtro dão o filtro por prefixo. A coluna `_cpf_ok` (com índice
parcial) marca a validade do CPF para o filtro "Apenas CPF válido". A
distribuição roda num **worker thread** (`facets-worker.js`, banco em modo
somente-leitura) e o resultado sem filtro fica numa tabela de **cache
persistente** (`app_cache`).

```
index.html / app.js / styles.css   Interface web (sem build), tema claro/escuro
server.js        Servidor Express e rotas da API
db.js            Conexão SQLite, schema, FTS, índices e migração automática
schema.js        Constantes de schema (colunas, chaves de filtro) — compartilhadas
querycore.js     Funções puras de consulta/facetas (usadas no servidor e no worker)
facets-worker.js Worker thread: distribuição/contagens sem travar o servidor
hygiene.js       Higienização: validação de CPF e conversão de datas
uf.js            Normalização de UF (junta SP / São Paulo / SAO PAULO)
mapping.js       De-para: colunas-destino × colunas de origem das planilhas
importer.js      Leitura em streaming, mapeamento e dedup por hash
store.js         Inserção, busca, filtros, facetas, exportação, higienização
data/            Banco SQLite (não versionado) — em produção, /data na Railway
```

## API (resumo)

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/api/upload` | Importa arquivos (campo `files`, multipart). |
| `GET` | `/api/stats` | Totais de registros e planilhas. |
| `GET` | `/api/columns` | Catálogo de colunas (pré-definidas). |
| `GET` | `/api/records` | Lista com `limit`, `offset`, `q`, `sort`, `dir`, filtros (`estado_funcionario`, `municipio_funcionario`, `cid_10`) e `valid_cpf=1`. |
| `GET` | `/api/distinct?col=` | Valores distintos de uma coluna de filtro. |
| `GET` | `/api/facets` | Distribuição (contagens) do recorte atual. |
| `GET` | `/api/facets.csv` | Exporta a distribuição em CSV. |
| `POST` | `/api/hygiene` | Inicia a higienização da base (lotes, segundo plano). |
| `GET` | `/api/hygiene` | Progresso da higienização (válidos/inválidos/a processar). |
| `GET` | `/api/imports` | Histórico de importações. |
| `GET` | `/api/export.csv` | Exporta a lista (respeita busca, filtros e `valid_cpf`). |
| `DELETE` | `/api/imports?source_file=` | Remove os dados de um arquivo. |
| `DELETE` | `/api/records` | Apaga todos os dados. |

## Limitações conhecidas

- O formato **`.xls` (Excel antigo, binário)** não é suportado — salve como `.xlsx`.
- Apenas as **colunas pré-definidas** (`mapping.js`) são guardadas.
- A deduplicação por identidade usa **CAT** ou **CPF válido**; sem nenhum dos
  dois, só junta linhas **idênticas** (mesmos valores nas colunas). Os
  duplicados **antigos** (anteriores a esta regra) só são reunidos quando a
  mesma chave reaparece num import; a limpeza em massa dos antigos é uma etapa
  separada (ainda não habilitada).
- O verificador de CPF confere o **dígito verificador** (se o número é
  matematicamente válido), **não** se ele pertence àquela pessoa — para isso só
  com a API paga da Receita Federal.

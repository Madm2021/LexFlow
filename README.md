# LexFlow

Sistema web para **subir, importar e unificar planilhas** em uma **base única**,
com **busca e filtros instantâneos**. Você arrasta seus arquivos `.xlsx` / `.csv`,
o LexFlow mapeia as colunas para um conjunto **pré-definido** de campos (CPF,
Nome, Cidade, Bairro, Estado, CID, Telefones, etc.), junta tudo numa só tabela,
**ignora linhas duplicadas** e permite pesquisar, filtrar por coluna, ordenar e
exportar tudo de uma vez.

> **Foco**: armazenar e consultar. É só isso — sem jurimetria, sem pontuação,
> sem triagem. Simples e rápido, mesmo com milhões de linhas.

## Principais recursos

- **Base única**: todas as planilhas alimentam uma só tabela, com a coluna
  *Origem* indicando de qual arquivo veio cada linha.
- **Colunas pré-definidas (de-para)**: layouts diferentes são unificados nas
  mesmas colunas. O mapeamento fica em `mapping.js` — adicione campos lá se
  precisar. Colunas fora dessa lista não são guardadas.
- **Busca full-text instantânea (FTS5)**: pesquise por nome, cidade, bairro, CID
  ou **CPF (com ou sem pontuação)** em qualquer lugar da base — sem varrer tudo.
- **Filtros por coluna**: estado e sexo (dropdown), município e bairro (começa
  com…), todos com índice — instantâneos.
- **Deduplicação automática**: cada linha recebe uma "impressão digital" (hash)
  com índice único. Subir a mesma planilha de novo não duplica os dados.
- **Upload por arrastar-e-soltar**, vários arquivos por vez (`.xlsx`, `.xlsm`, `.csv`).
- **Importação em streaming**: arquivos grandes (dezenas de MB, milhões de
  linhas) são lidos em lotes, com baixo uso de memória.
- **Exportação** para CSV (tudo ou só o resultado da busca/filtro), em streaming.
- **Histórico de importações**, com opção de remover os dados de um arquivo.
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
- `LEXFLOW_DB` — caminho do arquivo SQLite (padrão `data/lexflow.db`).
- `LEXFLOW_PASSWORD` — se definida, exige senha para acessar (tela de login).
  Sem ela, o acesso é livre (uso local). **Defina ao publicar na web.**
- `LEXFLOW_SECRET` — (opcional) segredo para assinar o cookie de sessão.

## Migração automática da base antiga

Se você já tinha uma base no formato antigo (schema "largo" + jurimetria), o
LexFlow **migra automaticamente** na primeira vez que sobe com este código:
mapeia as colunas para o novo formato enxuto, preserva o histórico e descarta as
colunas de pontuação. É feito numa transação (se falhar, nada muda).

> ⚠️ Durante a migração o banco chega a ocupar **~2x** (cópia temporária).
> Garanta espaço em disco sobrando — no Render, aumente o disco antes (ver
> `render.yaml`).

## Como funciona por baixo

Todas as planilhas alimentam uma única tabela `records` com **colunas fixas** (as
de `mapping.js`). Cada linha recebe um `_hash` com índice único; a inserção usa
`INSERT OR IGNORE`, então linhas idênticas são descartadas. Um índice **FTS5**
(`records_fts`, *external content* + triggers) sobre um texto concatenado
(`_search`) dá a busca instantânea; índices `COLLATE NOCASE` nas colunas de
filtro dão o filtro por prefixo instantâneo. A tabela `imports` guarda o
histórico.

```
index.html / app.js / styles.css   Interface web (sem build)
server.js     Servidor Express e rotas da API
db.js         Conexão SQLite, schema, FTS, índices e migração automática
mapping.js    De-para: colunas-destino × colunas de origem das planilhas
importer.js   Leitura em streaming, mapeamento e dedup por hash
store.js      Inserção, busca (FTS), filtros, exportação, histórico
utils.js      Sanitização de nomes e normalização de valores
data/         Banco SQLite (não versionado)
```

## API (resumo)

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/api/upload` | Importa arquivos (campo `files`, multipart). |
| `GET` | `/api/stats` | Totais de registros, colunas e planilhas. |
| `GET` | `/api/columns` | Catálogo de colunas (pré-definidas). |
| `GET` | `/api/records` | Lista com `limit`, `offset`, `q`, `sort`, `dir` e filtros (`estado_funcionario`, `municipio_funcionario`, `bairro_funcionario`, `sexo`). |
| `GET` | `/api/distinct?col=` | Valores distintos de uma coluna de filtro. |
| `GET` | `/api/imports` | Histórico de importações. |
| `GET` | `/api/export.csv` | Exporta a lista (respeita busca e filtros). |
| `DELETE` | `/api/imports?source_file=` | Remove os dados de um arquivo. |
| `DELETE` | `/api/records` | Apaga todos os dados. |

## Limitações conhecidas

- O formato **`.xls` (Excel antigo, binário)** não é suportado — salve como `.xlsx`.
- Apenas as **colunas pré-definidas** (`mapping.js`) são guardadas. Para incluir
  um campo novo, adicione-o ao `mapping.js` com seus nomes de origem.
- A deduplicação considera linhas **idênticas** (mesmos valores nas colunas
  pré-definidas).

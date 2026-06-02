# LexFlow

Sistema web para **subir, importar e unificar planilhas** em uma **lista única**.
Você arrasta seus arquivos `.xlsx` / `.csv`, o LexFlow descobre as colunas
automaticamente, junta tudo numa só tabela (a união das colunas de todos os
arquivos), **ignora linhas duplicadas** e permite visualizar, filtrar, ordenar,
buscar e exportar todos os dados de uma vez.

## Principais recursos

- **Lista única**: todas as planilhas alimentam uma só tabela de registros, com
  a coluna *Origem* indicando de qual arquivo veio cada linha.
- **Deduplicação automática**: cada linha recebe uma "impressão digital" (hash)
  com índice único. Subir a mesma planilha de novo não duplica os dados — as
  linhas repetidas são contadas e ignoradas.
- **Upload por arrastar-e-soltar**, vários arquivos por vez (`.xlsx`, `.xlsm`, `.csv`).
- **União de colunas**: arquivos com layouts diferentes são combinados; colunas
  que só existem em alguns arquivos ficam em branco nos demais.
- **Detecção automática de tipos** (texto, número, data) e do separador de CSV
  (`;`, `,`, tab, `|`), com suporte a formato numérico brasileiro (`1.234,56`).
  Códigos com zero à esquerda (CEP, CPF, PIS) são preservados como texto.
- **Importação em streaming**: arquivos grandes (50 mil+ linhas, dezenas de MB)
  são lidos em lotes, com uso de memória baixo.
- **Visualização** com paginação, ordenação por coluna e busca em toda a lista.
- **Exportação** para CSV (tudo ou só o resultado de uma busca).
- **Histórico de importações** com opção de remover os dados de um arquivo.
- **Banco único** em `data/lexflow.db` (SQLite).

## Como rodar

Pré-requisito: Node.js 18+.

```bash
npm install
npm start
```

Abra <http://localhost:3000> no navegador.

Para desenvolvimento (recarrega ao salvar):

```bash
npm run dev
```

### Variáveis de ambiente

- `PORT` — porta do servidor (padrão `3000`).
- `LEXFLOW_DB` — caminho do arquivo SQLite (padrão `data/lexflow.db`).
- `LEXFLOW_PASSWORD` — se definida, exige senha para acessar (tela de login).
  Sem ela, o acesso é livre (uso local). **Defina ao publicar na web.**
- `LEXFLOW_SECRET` — (opcional) segredo para assinar o cookie de sessão. Se
  ausente, é derivado da senha.

## Como funciona por baixo

Todas as planilhas alimentam uma única tabela `records` no SQLite. O catálogo
`columns` guarda a união das colunas vistas em todos os arquivos (cada coluna
nova é adicionada à tabela via `ALTER TABLE`). Cada linha recebe um `_hash`
(impressão digital) com índice único; a inserção usa `INSERT OR IGNORE`, então
linhas idênticas são descartadas automaticamente. A tabela `imports` registra o
histórico (arquivo, linhas adicionadas e ignoradas, data).

```
public/        Interface web (HTML/CSS/JS, sem build)
server.js      Servidor Express e rotas da API
src/
  db.js        Conexão SQLite e esquema (records, columns, imports)
  importer.js  Leitura em streaming, dedup por hash, união de colunas
  store.js     Catálogo de colunas, consultas, exportação, histórico
  utils.js     Sanitização de nomes, inferência de tipos, normalização
data/          Banco de dados SQLite (não versionado)
```

## API (resumo)

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/api/upload` | Importa arquivos (campo `files`, multipart). |
| `GET` | `/api/stats` | Totais de registros, colunas e planilhas. |
| `GET` | `/api/columns` | Catálogo de colunas (união). |
| `GET` | `/api/records` | Lista única com `limit`, `offset`, `q`, `sort`, `dir`. |
| `GET` | `/api/imports` | Histórico de importações. |
| `GET` | `/api/export.csv?q=` | Exporta a lista (ou o resultado de uma busca). |
| `DELETE` | `/api/imports?source_file=` | Remove os dados de um arquivo. |
| `DELETE` | `/api/records` | Apaga todos os dados. |

## Limitações conhecidas

- O formato **`.xls` (Excel antigo, binário)** não é suportado — abra no Excel e
  salve como `.xlsx`.
- Arquivos com layouts de coluna diferentes são unidos por **nome de coluna**;
  campos equivalentes com nomes diferentes (ex.: `CAT_NUMERO` x `Número da CAT`)
  ficam em colunas separadas. Um mapeamento semântico pode ser configurado à
  parte se necessário.
- A deduplicação considera linhas **idênticas** (todos os campos iguais).

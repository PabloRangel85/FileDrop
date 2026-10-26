# FileDrop

Compartilhamento efemero de arquivos por link, com expiracao por tempo ou por quantidade de downloads.

## Requisitos

- Node.js 22.5 ou mais recente (usa o SQLite integrado ao Node.js)
- npm

## Executar

```sh
npm install
npm start
```

Abra `http://localhost:3000`. Para desenvolvimento com reinicio automatico, use `npm run dev`. Para executar os testes, use `npm test`.

## Como funciona

- Envie um arquivo de ate 100 MB e escolha expiracao em 1 hora, 24 horas ou 7 dias, ou um limite de 1 a 100 downloads.
- O arquivo fica em `data/uploads/`; metadados e contadores ficam em `data/filedrop.sqlite`.
- O limite de downloads e aplicado atomicamente pelo SQLite. Links invalidos, expirados ou esgotados retornam HTTP 410.
- Arquivos com prazo sao removidos periodicamente. No modo por downloads, o arquivo e removido ao concluir o ultimo download permitido.
- Defina `PORT` para alterar a porta ou `FILEDROP_DATA_DIR` para mover o armazenamento. O limite por arquivo pode ser alterado com `FILEDROP_MAX_FILE_SIZE_BYTES`.

Esta versao guarda os arquivos no disco local; use um volume persistente ao executar em container.
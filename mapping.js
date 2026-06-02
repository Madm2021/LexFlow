'use strict';

/**
 * "De-para": mapeia as colunas-destino (lista enxuta aprovada pelo usuário) para
 * as colunas de origem (nomes sanitizados) que aparecem nos vários formatos de
 * planilha. Para cada registro, o valor é o primeiro de origem que estiver
 * preenchido (COALESCE, na ordem listada).
 *
 * A ordem das origens é por prioridade: primeiro os nomes já no formato limpo
 * do usuário (ex.: "datanascimento"), depois os formatos antigos/eSocial.
 *
 * Os dados originais (todas as colunas) continuam intactos na tabela "records";
 * isto aqui é apenas uma VISÃO limpa por cima. Ajustar este arquivo e recarregar
 * a página já muda o resultado — não é preciso reimportar.
 */
const MAPPING = [
  { key: 'cat', label: 'CAT', sources: ['cat', 'cat_numero', 'numero_da_cat'] },
  { key: 'cpf', label: 'CPF', sources: ['cpf'] },
  { key: 'nome', label: 'Nome', sources: ['nome'] },
  { key: 'data_nascimento', label: 'Data Nascimento', sources: ['datanascimento', 'data_nascimento', 'data_de_nascimento', 'data_nascimento_2'] },
  { key: 'nome_mae', label: 'Nome da Mãe', sources: ['nomedamae', 'nome_da_mae', 'nome_mae'] },
  { key: 'sexo', label: 'Sexo', sources: ['sexo', 'sexo_2'] },
  { key: 'remuneracao', label: 'Remuneração', sources: ['remuneracao', 'renda'] },
  { key: 'ctps', label: 'CTPS', sources: ['ctps'] },
  { key: 'identidade', label: 'Identidade', sources: ['identidade', 'rg'] },
  { key: 'endereco_funcionario', label: 'Endereço Funcionário', sources: ['enderecofuncionario', 'endereco_fun', 'logr_numero'] },
  { key: 'bairro_funcionario', label: 'Bairro Funcionário', sources: ['bairrofuncionario', 'bairro_fun'] },
  { key: 'cep_funcionario', label: 'CEP Funcionário', sources: ['cepfuncionario', 'cep_fun'] },
  { key: 'estado_funcionario', label: 'Estado Funcionário', sources: ['estado_funcionario', 'estado_fun', 'uf_2'] },
  { key: 'municipio_funcionario', label: 'Município Funcionário', sources: ['municipiofuncionario', 'municipio_fun'] },
  { key: 'telefone_funcionario', label: 'Telefone Funcionário', sources: ['telefonefuncionario', 'telefone_fun'] },
  { key: 'cbo', label: 'CBO', sources: ['cbo', 'cod_cbo'] },
  { key: 'local_acidente', label: 'Local do Acidente', sources: ['localdoacidente', 'local_do_acidente', 'especificacao_do_local_do_acidente'] },
  { key: 'parte_corpo', label: 'Parte do Corpo', sources: ['partedocorpo', 'parte_do_corpo', 'parte_do_corpo_atingida', 'parte_corpo_atingida'] },
  { key: 'agente_causador', label: 'Agente Causador', sources: ['agentecausador', 'agente_causador'] },
  { key: 'sit_gerador', label: 'Sit. Gerador', sources: ['sit_gerador', 'descricao_da_situacao_geradora_do_acidente_ou_doenca'] },
  { key: 'unidade', label: 'Unidade', sources: ['unidade'] },
  { key: 'data_atend', label: 'Data Atend.', sources: ['dataatend', 'data_atend', 'data'] },
  { key: 'nat_lesao', label: 'Nat. Lesão', sources: ['nat_lesao', 'natureza_da_lesao', 'descricao_e_natureza_da_lesao'] },
  { key: 'cid_10', label: 'CID-10', sources: ['cid_10', 'diagnostico_provavel'] },
  { key: 'observacoes', label: 'Observações', sources: ['observacoes', 'observacoes_2', 'obs'] },
  { key: 'telefone1', label: 'Telefone 1', sources: ['telefone1', 'celular1', 'fixo1'] },
  { key: 'telefone2', label: 'Telefone 2', sources: ['telefone2', 'celular2', 'fixo2'] },
  { key: 'telefone3', label: 'Telefone 3', sources: ['telefone3', 'celular3', 'fixo3'] },
  { key: 'email', label: 'E-mail', sources: ['e_mail', 'email', 'email1', 'emails'] },
];

module.exports = { MAPPING };

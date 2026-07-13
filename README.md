# Mapa de Apoiadores — Deputado Federal SP (v2)

Mapa interativo + cadastro externo por link + hierarquia + integração WhatsApp (n8n).
Dados permanentes em SQLite (`data/mapa.db`) com backup JSON automático em `data/backups/`.

## Como funciona o cadastro externo

1. Você (admin) cadastra um COORDENADOR no mapa. Ele ganha automaticamente um
   link exclusivo: `https://seudominio/c/CODIGO` (botão "copiar link de cadastro"
   no card dele ou na aba Equipe).
2. O coordenador manda esse link por WhatsApp para a rede dele. Quem abre vê
   "Você foi convidado por Fulano" e preenche: nome, WhatsApp e município.
   - Pelo link de um COORDENADOR: a pessoa entra como Cabo Eleitoral ou Apoiador.
   - Pelo link de um CABO: entra sempre como Apoiador.
3. Todo cadastro guarda quem indicou (hierarquia) e herda a dobrada do indicador.
4. A cada cadastro o servidor dispara um POST para o seu n8n (N8N_WEBHOOK_URL):

   { "evento": "novo_cadastro",
     "pessoa": { "id", "nome", "zap", "grau", "munId", "municipio" },
     "cadastradoPor": { "id", "nome", "grau" } }

   Seu fluxo manda o agradecimento no WhatsApp e vai perguntando dado por dado.
5. O n8n grava as respostas de volta no banco:

   PATCH https://seudominio/api/pessoas/{id}
   Header: X-Api-Key: (valor de N8N_KEY)
   Body (só o que quiser atualizar): { "nome", "endereco", "email", "votos", "obs", "zap" }

## Cadastro por WhatsApp (áudio ou texto) — o canal principal

O coordenador/cabo manda mensagem ou ÁUDIO para o WhatsApp da campanha:
"Quero cadastrar o Zé do Posto, telefone 18 98888-7777, de Presidente Prudente".
O agente do seu fluxo n8n conversa, extrai os dados e grava no mapa. O apoiador
aparece na hora: pin/cor no município, aba Equipe embaixo de quem cadastrou.

### Endpoints para o n8n (header X-Api-Key: N8N_KEY)

1) Identificar quem está falando (início da conversa):
   GET /api/whats/indicador?zap=5518991234567
   -> 200 { id, nome, grau, num, municipio, codigo }
   -> 404 { erro: "numero_nao_cadastrado" }  (não é coordenador/cabo: agente orienta)
   Aceita o número como vem do Evolution (55 + DDD, com ou sem 9º dígito).

2) Gravar o cadastro (fim da conversa, após confirmação):
   POST /api/whats/cadastro
   { "zapIndicador": "5518991234567",   <- número de quem está conversando
     "nome": "Zé do Posto",
     "zap": "18 98888-7777",            <- WhatsApp do novo apoiador
     "municipio": "presidente prudente",<- nome falado/escrito (acentos não importam)
     "grau": "Apoiador" }               <- opcional; cabo só cadastra Apoiador
   -> 200 { ok, pessoa:{id,nome,grau,municipio}, cadastradoPor }
   -> 400 municipio_nao_reconhecido / dados_incompletos (campo msg pronto p/ enviar)
   -> 409 ja_cadastrado

### Esqueleto do fluxo no n8n (mesma arquitetura do seu Snelfy)

  Webhook Evolution (mensagem recebida)
    -> IF áudio: baixar mídia -> transcrever (Gemini)
    -> HTTP GET /api/whats/indicador?zap={{remetente}}
         404? -> responder "este número não está cadastrado como coordenador" e parar
    -> Agente LLM com memória de sessão (Postgres, como na Nina):
         saudação usando {nome} e {grau}; perguntar/extrair: nome do apoiador,
         WhatsApp, município; confirmar os três antes de gravar
    -> HTTP POST /api/whats/cadastro
         erro 400/409? -> enviar o campo "msg" da resposta e voltar ao agente
    -> responder "✅ {pessoa.nome} cadastrado em {pessoa.municipio}!"

Após gravar, o servidor também dispara o N8N_WEBHOOK_URL (novo_cadastro) — use-o
para um SEGUNDO fluxo: dar boas-vindas ao apoiador no WhatsApp dele e completar
endereço/e-mail, gravando com PATCH /api/pessoas/{id}.

## Aba Equipe

Árvore Coordenador → Cabos → Apoiadores com contagem de quantos cada um cadastrou
(diretos e total). Atualiza sozinha a cada 45s e pelo botão "Atualizar".

## Banco de dados (SQLite — data/mapa.db)

  dobradas      id | nome | ini | cor
  pessoas       id | nome | grau | num | votos | zap | endereco | email |
                dob_id | obs | mun_id | pai_id (quem cadastrou) | codigo (do link)
  pessoa_muns   pessoa_id | mun_id  (municípios extras do coordenador)

## Variáveis de ambiente (.env)

  SENHA=            senha do painel admin (obrigatória)
  SECRET=           string aleatória longa (obrigatória) — ex.: openssl rand -hex 32
  N8N_WEBHOOK_URL=  URL do webhook do seu fluxo n8n (opcional)
  N8N_KEY=          chave que o n8n usa no PATCH (opcional) — ex.: openssl rand -hex 24

## Subir no VPS (Docker)

  1. scp -r mapa-web usuario@vps:/opt/
  2. cd /opt/mapa-web && cp .env.example .env && nano .env
  3. docker compose up -d --build
  4. DNS: registro A  mapa.seudominio.com.br -> IP do VPS
  5. Proxy reverso para a porta 3000 + HTTPS (certbot / EasyPanel / Traefik)

IMPORTANTE (LGPD): a base cruza nome + telefone + vínculo político (dado sensível,
art. 5º, II e art. 11). Só rode com HTTPS e senha forte. Os links de cadastro são
públicos por natureza — se um vazar, edite a pessoa e salve para manter, ou
exclua/recrie para trocar o código.

## Backup e migração

- Automático: snapshot JSON a cada mudança (máx. 1 a cada 10 min, mantém 60).
- Manual: copie a pasta data/ ou use "Exportar CSV" no mapa.
- Migrar da versão de teste do Claude: Exportar CSV lá -> Importar CSV aqui.
  (A importação SUBSTITUI tudo — use só na migração inicial.)

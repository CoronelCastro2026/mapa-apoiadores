# Fluxo do WhatsApp no n8n — guia prático

BASE = https://crm.coronelcastro.com.br
Todos os endpoints abaixo exigem o header:  X-Api-Key: <valor de N8N_KEY>

Quem já está cadastrado no mapa com WhatsApp é reconhecido automaticamente.
Não existe "habilitar coordenador" — cadastrou o número no mapa, ele já é atendido.

===============================================================================
FLUXO 1 — COORDENADOR/CABO CADASTRA (texto ou áudio)
===============================================================================

  [Webhook Evolution: mensagem recebida]
        |
  [IF] mensagem é áudio?  --sim-->  [baixar mídia] -> [Gemini: transcrever]
        |                                                      |
        +------------------ texto ------------------------------+
        |
  [HTTP GET] {{BASE}}/api/whats/indicador?zap={{ $json.remetente }}
        |
        |-- 404 --> responder: "Seu número não está cadastrado como coordenador
        |            ou cabo eleitoral. Fale com a equipe da campanha." (FIM)
        |
  [AI Agent] com memória de sessão (Postgres, igual à Nina do Snelfy)
        |     Recebe: nome={{nome}}, grau={{grau}}, municipio={{municipio}}
        |     Objetivo: extrair NOME, WHATSAPP e MUNICÍPIO do novo cadastrado,
        |     e o TIPO (cabo eleitoral ou apoiador) se quem fala é Coordenador.
        |
  [HTTP POST] {{BASE}}/api/whats/cadastro
        body: { "zapIndicador": "{{ $json.remetente }}",
                "nome": "...", "zap": "...", "municipio": "...",
                "grau": "Apoiador" | "Cabo Eleitoral" }
        |
        |-- 400/409 --> devolver o campo "msg" da resposta ao agente e continuar
        |               a conversa (ex: município não reconhecido, já cadastrado)
        |
  [Responder] "✅ {{pessoa.nome}} cadastrado em {{pessoa.municipio}}!"

REGRA AUTOMÁTICA: cabo eleitoral só cadastra Apoiador. Mesmo que ele peça
"cabo", o servidor grava como Apoiador. Não precisa tratar isso no fluxo.

--- PROMPT SUGERIDO PARA O AGENTE (Fluxo 1) ---
Você é a assistente da campanha do Coronel Castro. Está falando com {{nome}},
que é {{grau}} da campanha em {{municipio}}.

Sua função: ajudá-lo a cadastrar novos apoiadores e cabos eleitorais.
Cumprimente pelo nome na primeira mensagem e pergunte quem ele quer cadastrar.

Para cada pessoa, você precisa de 3 dados:
1. Nome completo
2. Número de WhatsApp (com DDD)
3. Município (cidade de São Paulo)
{{#se grau == "Coordenador"}}4. Se é Cabo Eleitoral ou Apoiador (se não disser, é Apoiador){{/se}}

Regras:
- Aceite os dados em qualquer ordem, em uma mensagem só ou aos poucos.
- Se ele mandar áudio com vários nomes, cadastre um de cada vez, confirmando.
- Antes de gravar, repita os 3 dados e peça confirmação ("Confirma?").
- Fale de forma simples e direta. Muitos coordenadores têm pouca familiaridade
  com tecnologia. Nunca use termos técnicos.
- Se faltar um dado, pergunte só o que falta.

===============================================================================
FLUXO 2 — AGRADECIMENTO E COMPLEMENTO DE DADOS
===============================================================================

Assim que alguém é cadastrado, o servidor dispara um POST no seu N8N_WEBHOOK_URL:

  { "evento": "novo_cadastro",
    "pessoa": { "id", "nome", "zap", "grau", "munId", "municipio" },
    "cadastradoPor": { "id", "nome", "grau" } }

  [Webhook: novo_cadastro]
        |
  [Evolution: enviar mensagem para {{pessoa.zap}}]
        "Olá, {{pessoa.nome}}! Aqui é a assistente do Coronel Castro.
         Você foi indicado(a) por {{cadastradoPor.nome}} e agradecemos muito
         seu apoio à nossa campanha! 🙏
         Posso te fazer algumas perguntinhas rápidas para completar seu cadastro?"
        |
  [AI Agent] coleta, um de cada vez: nome completo, apelido, e-mail,
        |     profissão, endereço, aniversário (dia/mês).
        |     Permite pular qualquer campo. Não insiste.
        |
  [HTTP PATCH] {{BASE}}/api/pessoas/{{ pessoa.id }}
        body: { "nome": "...", "apelido": "...", "email": "...",
                "profissao": "...", "endereco": "...", "aniversario": "12/03",
                "completo": true }

Se a pessoa responder depois (ou você quiser retomar), descubra quem é e o que
falta pelo número dela:

  GET {{BASE}}/api/whats/pessoa?zap=5518992223333
  -> { id, nome, apelido, email, profissao, endereco, aniversario, grau,
       municipio, cadastradoPor, completo,
       faltando: ["apelido","email","profissao","endereco","aniversario"] }

O campo "faltando" já diz ao agente exatamente o que perguntar.

--- PROMPT SUGERIDO PARA O AGENTE (Fluxo 2) ---
Você é a assistente da campanha do Coronel Castro, falando com {{nome}},
que acabou de ser cadastrado(a) como apoiador por {{cadastradoPor}}.

Seja calorosa e breve. Agradeça o apoio.
Pergunte, UM DE CADA VEZ, apenas o que está em {{faltando}}:
nome completo, apelido, e-mail, profissão, endereço, aniversário (dia e mês).

Regras:
- Uma pergunta por mensagem. Nunca despeje tudo de uma vez.
- Se a pessoa não quiser responder algo, aceite e siga para o próximo.
- Se ela quiser parar, agradeça e encerre.
- Ao final, agradeça e diga que a campanha vai manter contato.

===============================================================================
NO MAPA
===============================================================================

- O cadastro aparece no município em segundos (o painel atualiza a cada 45s).
- Aba EQUIPE mostra a árvore: Coordenador -> Cabos -> Apoiadores, com quantos
  cada um cadastrou.
- Quem ainda não completou os dados aparece com "⏳ aguardando completar dados
  pelo WhatsApp", e o total de pendentes aparece no topo da aba Equipe.
- Exportar CSV traz todas as colunas (apelido, profissão, aniversário, quem
  cadastrou, se completou).

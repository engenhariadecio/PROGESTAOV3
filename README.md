# Décio — Sistema Integrado da Montagem

Um único aplicativo, um único banco Postgres e um único login para os três sistemas do setor:

| # | Sistema | Rota | O que faz |
|---|---------|------|-----------|
| 01 | **Ponto NFC** | `/ponto` | Batida por crachá NFC ou seleção manual, com turno identificado automaticamente |
| 02 | **Cadenciador de Produção** | `/cadenciador` | Cadência por takt time, avisos de voz, parada de linha e painel de chão de fábrica |
| 03 | **ProGestão** | `/progestao` | Ferramentas, EPIs, banco de horas, treinamentos, diário de bordo, checklist e produção |

Tudo é configurado em um lugar só: **`/admin`** (Painel de Administração).

---

## O que mudou em relação aos três projetos originais

Os sistemas eram independentes e guardavam dados em lugares diferentes. Agora compartilham banco, login e turnos.

**Ponto NFC**
- Os 18 crachás deixaram de ser uma constante `COLLABORATOR_MAP` dentro do HTML e viraram cadastro no banco.
- Os registros saíram do `localStorage` do celular e vão para o Postgres — não se perdem ao limpar o navegador.
- A senha de administrador `"1234"` no código-fonte foi substituída pelo login com sessão e perfis.
- Cada batida grava o turno em que ocorreu e alterna entre entrada e saída.

**Cadenciador de Produção**
- Os 69 produtos e seus takt times saíram do array `PRODUTOS_PADRAO` e viraram cadastro editável.
- O turno deixou de ser fixo em `06:00–17:30`: agora vem do cadastro, e o takt pode ser diferente por turno.
- Os intervalos (café, almoço) são cadastráveis, com a frase do aviso de voz.
- Ciclos, observações e paradas de linha são gravados no banco — o relatório sobrevive a um F5.
- A senha `"producao2025"` no código foi substituída pelo login.
- O cálculo dos ciclos foi reescrito, mas produz **exatamente os mesmos horários** do algoritmo original (verificado nos 69 takts reais). A diferença é que passou a funcionar em turnos que viram a meia-noite.

**ProGestão**
- **Correções necessárias:** o `db.js` antigo criava tabelas com colunas que nenhuma rota usava (`colaboradores.matricula` vs `mat`, `ferramentas.codigo` vs `cod`, e assim por diante). O sistema quebrava no primeiro cadastro. O schema foi reescrito a partir das rotas reais.
- `GET /api/ferramentas/checklist` era capturado pela rota `/:id` e virava `WHERE id = 'checklist'`. Rota reordenada.
- As consultas de aniversariantes usavam `HAVING` sem `GROUP BY`, o que o Postgres rejeita. Reescritas com subquery.
- Layout retematizado com a identidade da Décio.

**Ensinar a IA de dentro do Cadenciador (22/10/2026)**
- No cartão *Câmera do pallet* do Cadenciador: **🧠 Ensinar a IA deste produto** e **▭ Área e câmera**. Abrem em tela cheia, sem sair do Cadenciador, a tela de treino já na célula e no **produto em linha** (o modelo fica salvo para aquele produto naquela célula). Ao fechar, volta ao Cadenciador e o tablet baixa o modelo sozinho.
- O cartão mostra se o produto em linha já tem IA treinada ("✓ IA treinada para X · N quadros · acerto 99%") ou o aviso para treinar. Se houver só o modelo geral da câmera, avisa que dá para treinar um específico.
- O painel das câmeras aceita `?linha=ID&produto=PID&aba=ia|area&embed=1` (abre direto no treino/área daquela câmera).

**Só conta quando alguém mexe no pallet; deploy pelo Dockerfile (22/10/2026)**
- A IA de pessoas (MediaPipe Pose) passou a acompanhar as **mãos** (pulsos e dedos). Uma colocação/retirada só é contada se, nos ~25 s anteriores, uma **mão entrou na área do pallet**, a IA viu a **pessoa** sobre ele ou houve **movimento grande/contínuo** ali. Caixa que "aparece" ou "some" sem ninguém mexer (sombra, reflexo, a IA oscilando) só ajusta a referência, sem contar. O HUD mostra "✋ mão no pallet" e as mãos como pontos.
- Área automática acima do pallet vale para qualquer ângulo (de lado, de cima, inclinado) e não "pula" quando alguém tapa o pallet (só se move se o pallet aparecer em outro lugar em 4 leituras seguidas).
- *Ensinar a IA › Treinar*: opção **usar os quadros de todas as câmeras** — um modelo só com vários ângulos.
- `railway.json` agora usa **builder DOCKERFILE** (antes era NIXPACKS e o Dockerfile era ignorado, então o treino nunca era instalado no Railway). O primeiro build demora ~10 min; health check com 300 s.

**IA com 3 classes: CAIXA, PEÇA e PALLET (21/10/2026)**
- Em *Ensinar a IA › Contar cada caixa/peça no pallet* (agora o modo padrão), cada retângulo tem uma classe: **Caixa**, **Peça** ou **Pallet** (botões coloridos antes de arrastar). O treino gera um detector com as 3 classes (`treinar.py --classes caixa,peca,pallet`; métricas por classe aparecem no painel).
- Na câmera: a IA acha o **pallet** sozinha e conta só o que está em cima dele (coluna acima do pallet) — **não precisa marcar área** (se marcar, a área marcada manda). Cada classe é comparada com a última contagem estável (cena parada, ninguém na frente, ~2,5 s): **+n colocadas / −n retiradas**, com o detalhe *caixa* ou *peça* gravado no evento (`cont_eventos.detalhe`). **Pallet sumiu** = "pallet saiu" e **pallet novo** = "pallet novo vazio/com itens" — registrados como troca, não como retiradas. O HUD e o painel mostram "PALLET VAZIO", "pallet com 2 caixas, 1 peça" ou "sem pallet".
- Modelos antigos de 1 classe continuam funcionando como antes.

**Modo "pallet vazio × com peças" (21/10/2026)**
- Em *Ensinar a IA* há agora dois modos. **Pallet vazio × com peças** (padrão): não precisa marcar retângulo — só capturar quadros com os botões *pallet VAZIO* / *COM PEÇAS* (10 ou mais de cada, variando quantidade, posição, luz e gente ao redor) e *Treinar* (2–5 min; classificador YOLOv8n-cls sobre o recorte da área do pallet, `python/pesos/yolov8n-cls.pt`). A câmera passa a classificar a área o tempo todo e conta **+1 cada vez que o pallet sai de vazio para com peças**; quando volta a vazio registra *pallet liberado*. Se a área marcada mudar, treine de novo. **Contar cada peça** continua sendo o modo com retângulos.
- Tabelas: `cont_amostras.rotulo`, `cont_modelos.tipo/classes`. `treinar.py --modo cls --zona x,y,w,h`. O servidor de teste em Python também suporta.

**Rodar no PC com HTTPS (20/10/2026)**
- `HTTPS=1` no `.env` sobe o servidor em HTTPS com certificado autoassinado (gerado em `.cert/`), para a câmera dos tablets/celulares funcionar na rede local sem Railway. O console mostra os IPs da rede. Passo a passo para Windows na seção *Rodar na sua máquina*.

**IA de verdade: ensinar a câmera a reconhecer as caixas/peças (20/10/2026)**
- Painel das câmeras › Configurar › aba **Ensinar a IA**: *Capturar quadro da câmera* → arrastar um retângulo em volta de cada caixa/peça → *Salvar*. Com 15–30 quadros marcados (pilha vazia, meio, cheia, gente passando), **Treinar IA** (5–15 min). O servidor treina um detector YOLOv8n (partindo dos pesos Open Images, que já conhecem "Box") só com as caixas daquela câmera/produto e exporta ONNX; o aparelho baixa sozinho e passa a contar **por reconhecimento**: conta as caixas detectadas dentro da área e, quando a contagem fica estável por ~2,5 s sem ninguém na frente, registra +n ou −n. Sem modelo treinado, continua a contagem por diferença de imagem.
- Modelo por câmera e, se quiser, por produto (o produto sobrepõe o geral). "Remover modelo" volta ao modo anterior. Tabelas `cont_amostras` e `cont_modelos`; rotas `/api/contador/linhas/:id/amostras|treinar|treino|modelo`.
- Roda no aparelho com `onnxruntime-web` (`public/js/ort/`, sem CDN). O treino precisa de Python no servidor: o novo **Dockerfile** instala Node + Python + ultralytics (o Railway usa o Dockerfile automaticamente; primeiro build demora ~10 min). Sem Python o sistema roda igual e o painel avisa que o treino está indisponível (`python/README.md`).
- O quadro ao vivo passou a 640×480 e é guardado sem desenhos para servir de amostra.

**Contador dentro do Cadenciador (20/10/2026)**
- Não existe mais "Contador" como sistema separado (saiu do portal e do menu). O fluxo é um só, no Cadenciador: **turno → célula → produto → Iniciar linha → Conectar câmera**. Depois de iniciar, o cartão *Câmera do pallet* oferece **📷 Usar a câmera deste aparelho** ou **📱 Conectar um celular (QR)**. Com um celular conectado, o tablet mostra a imagem dele, a contagem e os botões +1/−1 (comandos remotos). A escolha "este aparelho" fica lembrada para a próxima vez.
- Endereços: `/cadenciador/painel` (painel das câmeras: ao vivo, configurar, análise, histórico — também no botão *Painel das câmeras*) e `/cadenciador/camera` (aparelho que filma; é o link do QR). Os antigos `/contador` e `/contador/painel` continuam funcionando.
- Um aparelho que parou de transmitir deixa de mandar no produto/sessão da linha (o painel volta a seguir o que o tablet iniciou).

**Câmera: colocada e retirada, sem calibrar caixa (20/10/2026)**
- A detecção passou a trabalhar por **manchas de mudança** na área marcada (componentes conexos sobre a diferença de **cor** entre a cena e a referência — papelão sobre piso cinza tem o mesmo brilho, mas não a mesma cor). Cada mancha compacta é uma caixa; a câmera **aprende o tamanho típico sozinha** nas primeiras contagens (mediana), então marcar o tamanho da caixa virou opcional. Mancha do tamanho de 2 caixas conta 2.
- **Retirada conta −1**: a cor da mancha é comparada com o modelo de fundo (faixa de cima da área na calibração — por isso a área deve ir até acima da pilha mais alta). Ficou parecida com o fundo → retirada (`ia_retirada`); senão → colocada (`ia`). Alguém que só parou na frente e saiu gera +1 e −1 (saldo zero); gente passando atrás ou na frente sem mexer não gera nada (a cena volta ao que era). A opção "várias por vez" e o estorno automático saíram (ficaram automáticos).
- Painel/histórico/Excel mostram colocadas e retiradas separadamente.

**Cadenciador + câmera integrados, config por produto (20/10/2026)**
- No **Cadenciador** do tablet da célula a barra de início ganhou **Célula** (filtra os produtos vinculados a ela) e **Câmera do pallet** (*Sem câmera* / *Câmera deste aparelho* / *Outro aparelho*). **Iniciar linha** abre a sessão e, no mesmo gesto, liga a câmera: cadência, avisos de voz, contagem e o gráfico **Produção em tempo real — takt × produzido** rodam juntos. O painel de chão ganhou a caixa **Produzido (câmera)**. Trocar o produto com a câmera ligada mantém a câmera e passa a contar na nova sessão.
- O motor da câmera virou `public/js/contador-cam.js`, usado pelo Cadenciador e pela página `/contador` (celular avulso, para quando a câmera fica num aparelho separado do tablet).
- **Configuração por câmera e por produto**: área do pallet, câmera, resolução, zoom e lanterna ficam na câmera da célula (o pallet é sempre o mesmo); **tamanho da caixa, sensibilidade e "várias por vez" ficam por produto** (`cont_linha_produto`). No painel, *Configurar câmera* tem o seletor de produto (segue o produto que o tablet está rodando) e "voltar ao padrão da linha". No tablet, marcar o tamanho da caixa já salva para o produto em linha.
- A câmera da célula é criada automaticamente ao iniciar a linha com câmera (`POST /api/contador/linhas`, qualquer perfil exceto PCP); o painel passou a chamá-la *Câmera de célula*.

**Contador por câmera (20/10/2026)** — `/contador/painel` (PC) e `/contador` (celular avulso)
- **Fluxo**: no PC, o admin cria a **linha** (célula + produto do cadenciador) em *Nova linha*; aparece um link/QR. No celular, abre-se o link, faz-se login e toca-se em **Conectar câmera**. A imagem aparece no painel em seguida e **toda a configuração é feita pelo PC**, sobre a imagem ao vivo: arrastar a **área do pallet** e o **tamanho de uma caixa**, sensibilidade, câmera (lista de câmeras do celular), resolução, zoom e lanterna (quando o celular permite), além de comandos remotos (recalibrar, pallet trocado, +1/−1, reiniciar câmera, encerrar). O celular busca a configuração a cada 1,5 s e aplica. Um celular por linha; várias linhas ao mesmo tempo.
- **Como conta** (vista lateral, caixas empilhadas): a IA (MediaPipe Pose, rodando no próprio celular, sem nuvem — `public/js/mediapipe/pose/`) detecta a pessoa. Quando a área fica livre e parada por ~3 s, compara-se com a referência: mudou pelo menos uma fração de caixa (calibrada pelo tamanho marcado) → **+1** com foto de evidência; mudou "muitas caixas" → **troca de pallet** (não conta); não mudou → nada. A câmera estorna sozinha se a área voltar a ficar como antes da contagem (pessoa parada, não produto). Opcional: contar várias caixas colocadas de uma vez. Botões +1/−1 no celular e no PC; fila offline.
- **Painel ao vivo**: imagem de cada linha (quadro JPEG a cada ~0,7 s, só o último fica em memória — nada de vídeo no banco), contado × esperado pelo takt, diferença, estado; botão **Iniciar cadenciador** abre a sessão de hoje para o produto da linha no turno atual. **Análise × takt** por dia/linha: acumulado esperado × real, intervalo entre saídas × takt, produção por hora, KPIs, eventos com foto. **Histórico** e Excel (`/api/export/contador`).
- Tabelas `cont_linhas` (config em JSON) e `cont_eventos`; rotas `/api/contador/*`; pacote `qrcode` para o QR. PCP vê o painel (somente leitura). Datas/horas no fuso do Node (`TZ`), não no do Postgres.
- Recomendações: o navegador só libera a câmera em **HTTPS** (Railway já é) ou em `localhost`; suporte fixo + carregador; a área marcada deve cobrir toda a altura das pilhas; marcar o tamanho de uma caixa deixa a contagem bem mais confiável; luz estável. Expectativa de 90–95 % de acerto — conferir pelo painel na primeira semana.

**Dashboards de Produção, células com operadores, mostrar senha (08/10/2026)**
- Login: ícone de olho para mostrar/ocultar a senha.
- Produção › Dashboard refeito. Seletor de dashboard + filtros de período (este mês, mês passado, 30/90 dias, ano, mês, intervalo), material, categoria, OP, célula e turno — independentes do filtro de mês do topo.
  - **Meta × Realizado** (base: plano mensal): linha do plano (valores exatos do Plano Mensal: na data de cada plano a linha sobe a meta dele, fechando na meta total) × linha do atendimento (realizado desses planos acumulado pelo dia dos apontamentos, fechando no realizado total do Plano Mensal);  linha do atendimento (realizado acumulado dos apontamentos); meta × realizado por material; % de atendimento por OP; situação dos planos; produção por dia × meta diária.
  - **Horas produzidas × Horas disponíveis** (base: apontamento diário, por célula): horas disponíveis = operadores × horas por operador (padrão 7 h) × dias úteis do período; produzidas = horas reportadas nos apontamentos. Gráfico por célula, por dia, eficiência, participação e tabela-resumo.
- Nova aba **Células** em Produção: nome, categoria, **turno** (1º/2º/3º ou todos), operadores, horas por operador, descrição, ativa/inativa. Escolher a célula no apontamento preenche o turno dela; o filtro de turno do dashboard de horas considera o turno da célula. O select de célula do apontamento vem desse cadastro (as opções fixas foram removidas). Mesma tabela `celulas` da administração (colunas novas `categoria`, `operadores`, `horas_operador`). Rotas `/api/prod-celulas`.
- Chart.js passou a ser servido localmente (`public/js/chart.umd.js`), sem depender de CDN.

**Observações do status do plano (02/10/2026)**
- Em Produção › Plano Mensal e Histórico, ao lado do status de cada plano há um balão 💬 (com a contagem). Abre uma janela com o histórico de observações: quem escreveu, quando e qual era o status na hora.
- Administrador e Operação registram novas observações; o PCP só visualiza (o servidor devolve 403 em qualquer gravação). Excluir: só o administrador ou o autor.
- Tabela `prod_plano_obs`; rotas `GET/POST /api/prod-planos/:id/observacoes` e `DELETE /api/prod-plano-obs/:id`.

**Perfil PCP (02/10/2026)**
- Novo perfil de usuário **PCP** (Administração → Usuários → Perfil): só visualiza ProGestão › Produção. Entra direto em `/progestao/producao`; a tela esconde os formulários, botões de editar/excluir, a aba de apontamento e o menu dos outros módulos.
- A restrição é no servidor (`middleware/auth.js › restringirPcp`): qualquer outra página redireciona para Produção e qualquer API fora de leitura de Produção responde 403, mesmo chamando direto.

**Banco de horas: compensação e filtro global · Produção: editar apontamento (28/09/2026)**
- Banco de Horas tem o tipo **Desconto**: horas descontadas ficam registradas, mas **não entram no saldo** — assim como Justificado (atestado/declaração). Saldo = Crédito − Débito. KPIs "Desconto" e "Saldo (créd − déb)". (Lançamentos antigos gravados como "Compensação" são convertidos para "Desconto" no boot.)
- Filtro no topo da página (período: hoje, esta semana, este mês, mês, semana, intervalo; colaborador; turno; tipo) que vale para os KPIs, a tabela de lançamentos e o saldo. Abre em "este mês".
- Produção → Apontamento Diário: botão ✏️ na lista carrega o apontamento no formulário para edição. `PUT /api/prod-apontamentos-detalhados/:id` recalcula o realizado do plano (tira da OP antiga, soma na nova).

**Advertências (24/09/2026)** — aba nova em Treinamentos
- Registro por colaborador com tipo (Verbal, Escrita, Suspensão com dias), data, motivo, descrição dos fatos, quem aplicou (em branco = usuário logado), testemunhas, se o colaborador assinou ou recusou, e fotos do documento assinado.
- Ao escolher o colaborador, o formulário mostra quantas advertências ele já tem. O histórico numera (1ª, 2ª, 3ª...) e filtra por colaborador, tipo e mês; detalhe em modal; Excel em `/api/export/advertencias`.
- Tabela `tr_advertencias` guarda uma cópia do nome do colaborador para o registro sobreviver à exclusão do cadastro.

**Desligados fora de todas as listas (24/09/2026)**
- Regra única em todos os módulos: cada tela carrega a lista de colaboradores **sem os desligados** (`colabs`) e guarda a completa (`colabsTodos`) só para exibir o nome em registros antigos. Vale para selects de lançamento, checking de EPIs, saldo do banco de horas, sugestões do diário, aba Colaboradores de ferramentas, responsável/filtros de limpeza e vínculo de crachá na administração.
- Ao editar um registro de quem já foi desligado (lançamento, convite, agendamento, crachá), o nome dele continua na lista, marcado "(desligado)", para não perder o vínculo.

**Módulo Limpeza (23/09/2026)** — `/progestao/limpeza`
- **Itens** com local, frequência (a cada N dias/semanas/meses), antecedência do aviso, responsável padrão, descrição e fotos. A próxima limpeza é a última feita + frequência (ou a data de início, se nunca foi feita).
- **Alertas**: itens agrupados em Vencidos / Vencem hoje / A vencer / Em dia, com "Registrar limpeza" (quem, data, hora, obs) e "Agendar" direto no card.
- **Agenda**: por dia, com colaborador e turno. "Gerar agenda" cria os agendamentos de todos os itens pela frequência até uma data (pulando fins de semana, sem duplicar). Dar baixa num agendamento vira registro no histórico; registrar pelo item dá baixa no agendamento aberto mais próximo.
- **Histórico** filtrável por item, colaborador e mês, com Excel (`/api/export/limpeza`).
- Tabelas `lp_itens` e `lp_agenda` (agendado/feito na mesma tabela); rotas em `routes/limpeza.js`.

**Desligamento, EPI descartável, seed (22/09/2026)**
- Colaborador tem o status **Desligado** com data (Administração → Colaboradores → Editar). Some das listas de lançamento (banco de horas, EPIs, ferramentas, treinamentos, diário), mas todo o histórico continua. Na lista da administração ficam ocultos por padrão; há um "Mostrar desligados".
- `seed.js` só cria os colaboradores e crachás padrão no **primeiro boot** (banco sem colaboradores). Antes rodava a cada deploy e recriava, como Ativo, qualquer montador padrão que tivesse sido excluído.
- EPI **descartável** (checkbox no cadastro): quando a validade passa, a entrega vira "Descartado" em vez de "Vencido" e não gera alerta. EPIs já cadastrados com "descart" no nome foram marcados automaticamente uma única vez.

**Banco de horas e EPIs (22/09/2026)**
- Banco de Horas tem o tipo **Justificado** (atestado, declaração): fica registrado com os minutos, aparece nos KPIs, no saldo por colaborador e no histórico, mas não soma nem desconta do saldo. A API só aceita Crédito, Débito ou Justificado.
- EPIs: quando um colaborador recebe uma nova entrega do mesmo EPI, a entrega anterior passa a **Substituído** e sai dos alertas, dos vencidos e dos KPIs. Vale para qualquer entrega anterior, vencida ou não. A regra é calculada na tela a partir das datas, então funciona também para entregas antigas.
- Entregas → Motivo: opção **Esqueceu**.

**Checklist de ferramentas e filtro do banco de horas (11/09/2026)**
- A aba *Checklist* em Ferramentas virou uma conferência com histórico: cada ferramenta recebe OK / Com problema / Não encontrada, com observação, e o botão **Salvar conferência** grava tudo com data, hora, turno e responsável (tabelas `ferr_checklists` e `ferr_checklist_itens`). O que foi marcado fica guardado no aparelho até salvar, então um F5 não perde nada. A versão anterior nunca gravou: a tela e a API usavam formatos diferentes.
- Cada item guarda uma cópia do código, nome e status da ferramenta naquele momento — renomear ou excluir a ferramenta depois não altera o histórico.
- Exportação em *Relatórios → Conferências* (Excel com duas abas: conferências e itens).
- Banco de Horas → Lançamentos: filtros por colaborador, tipo e mês, com o saldo do que está filtrado.

**Fotos nos cadastros (setembro/2026)**
- Todos os cadastros do ProGestão aceitam fotos: ferramentas, EPIs, treinamentos, atividades do checklist e produtos. No Diário de Bordo, tanto ocorrências/pendências quanto resumos do turno.
- As imagens são reduzidas no navegador antes do envio (lado maior 1600 px, JPEG). Uma foto de celular de 5 MB vira ~300 KB; a localização GPS gravada na foto é descartada.
- No celular há o botão **Tirar foto**, que abre a câmera. No computador dá para arrastar ou colar com Ctrl+V.
- As fotos ficam na tabela `fotos`, uma linha por imagem, com miniatura. As listagens só baixam a miniatura; a foto inteira só quando alguém abre o visualizador.
- Fotos antigas (base64 nas colunas `epis.foto`, `ferramentas.foto`, `db_registros.foto/fotos`) são migradas automaticamente no primeiro boot.
- Excluir um cadastro apaga as fotos dele (gatilho no banco).
- Limites: 20 fotos por registro, 5 MB por foto depois de comprimida. Só JPG, PNG, WEBP e GIF — o servidor confere o conteúdo do arquivo, não a extensão.
- Também foi corrigido o cadastro de ferramentas, que não gravava: a tela enviava `codigo`/`categoria`/`localizacao` e a API só aceitava `cod`/`cat`/`loc`. Empréstimos e manutenções tinham o mesmo problema. A API agora aceita e devolve os dois nomes.

---

## Subir no GitHub

```bash
cd decio-sistema-integrado
git init
git add .
git commit -m "Sistema Integrado da Montagem"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/decio-sistema-integrado.git
git push -u origin main
```

O `.gitignore` já exclui `node_modules/` e `.env`. **Nunca faça commit do `.env`.**

---

## Publicar no Railway

**1. Criar o projeto**

No [railway.app](https://railway.app): *New Project* → *Deploy from GitHub repo* → escolha o repositório.

**2. Adicionar o Postgres**

No mesmo projeto: *New* → *Database* → *Add PostgreSQL*.

**3. Configurar as variáveis**

No serviço do app, aba *Variables*:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` ← referência ao banco, digite exatamente assim |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | uma string longa e aleatória (veja abaixo) |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASS` | a senha inicial do administrador |
| `ADMIN_NOME` | `Administrador` |
| `TZ` | `America/Sao_Paulo` |
| `SEED_ON_BOOT` | `true` |

Para gerar o `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`PORT` é injetada pelo Railway — não crie essa variável.

**4. Publicar**

O Railway detecta o `package.json` e roda `npm start`. No primeiro boot o app:
1. cria todas as tabelas (`db/schema.js`);
2. aplica migrações defensivas, se o banco já existia;
3. popula turnos, células, os 18 crachás, os 69 produtos e o usuário administrador (`db/seed.js`).

Depois vá em *Settings* → *Networking* → *Generate Domain*.

**5. Primeiro acesso**

Entre com `ADMIN_USER` / `ADMIN_PASS` e **troque a senha imediatamente** em *Administração → Usuários → Trocar senha*.

---

## Rodar na sua máquina

**Só para testar a câmera/IA, sem instalar nada (Python puro):**

```bat
python servidor_teste.py
```
Serve as mesmas páginas e o mesmo motor da câmera do sistema publicado, com um servidor mínimo no lugar do Node/Postgres (uma linha fixa "Teste", dados em `teste_dados/`). No PC: `https://localhost:3000/cadenciador/painel`; no celular/tablet: `https://IP-DO-PC:3000/cadenciador/camera` (aceite o aviso do certificado). Marcar área, capturar quadros, ensinar e treinar a IA funcionam; o treino exige `python -m pip install -r python/requirements-local.txt`. Não tem login, cadenciador nem banco — é só para ver se a câmera reconhece.

**Jeito mais fácil para rodar o sistema inteiro — só com Python (sem instalar Node nem Postgres):**

```bat
python iniciar_pc.py
```
Precisa de Python 3.10, 3.11 ou 3.12 (se o seu for 3.13+, instale também o 3.12 e use `py -3.12 iniciar_pc.py`). Na primeira vez ele baixa um Node.js e um PostgreSQL embutidos via `pip`, cria o banco em `.banco/`, grava o `.env`, roda o `npm install` e sobe em `https://localhost:3000` (mostra também o endereço na rede local para os tablets). Depois é só rodar o mesmo comando; `Ctrl+C` para. Para o treino da IA: `python -m pip install -r python\requirements-local.txt`.

**Windows, passo a passo com Node e Postgres instalados (para usar o sistema no PC com os tablets/celulares na mesma rede):**

1. Instale o **Node.js LTS** (nodejs.org) e o **PostgreSQL** (postgresql.org › Windows installer; anote a senha do usuário `postgres`).
2. No *pgAdmin* (vem com o Postgres) ou no `psql`, crie o banco: `CREATE DATABASE decio;`
3. Descompacte o projeto numa pasta (ex.: `C:\decio`). Copie `.env.example` para `.env` e ajuste `DATABASE_URL` com a sua senha:
   `DATABASE_URL=postgres://postgres:SUA_SENHA@localhost:5432/decio`
4. No *Prompt de Comando* dentro da pasta:
   ```bat
   npm install
   npm start
   ```
   O console mostra os endereços, por exemplo `https://192.168.0.15:3000`.
5. **Câmera**: o navegador só libera a câmera em HTTPS. O `.env.example` já vem com `HTTPS=1`: o sistema gera um certificado próprio e sobe em `https://`. No tablet/celular, abra `https://IP-DO-PC:3000`, o navegador avisa "conexão não segura" → *Avançado* → *Continuar*. Feito uma vez, não pergunta mais. (No próprio PC, `http://localhost:3000` também libera a câmera.)
6. **Treinar a IA** (opcional): instale o **Python 3.10+** (python.org, marque *Add to PATH*) e rode `pip install -r python\requirements-local.txt` (baixa ~1 GB; só uma vez). No `.env`, `PYTHON_BIN=python`. Sem isso tudo funciona, só o botão *Treinar IA* fica indisponível.
7. Libere a porta 3000 no Firewall do Windows (ou aceite o aviso na primeira execução) para os tablets enxergarem o PC. Para o PC ser um "servidor" de verdade, deixe-o ligado e com IP fixo no roteador.

Login inicial: `admin` / senha do `ADMIN_PASS` do `.env`.

**Linux/Mac:**

```bash
npm install
cp .env.example .env      # edite o DATABASE_URL
npm run dev
```

Acesse `http://localhost:3000`.

Para recriar tabelas e dados iniciais sem subir o servidor:
```bash
npm run db:seed
```

---

## Turnos: o eixo que liga os três sistemas

Um turno tem código, nome, hora de início, hora de fim, tolerância e uma lista de intervalos.

- **Ponto NFC** — descobre o turno pelo horário da batida. A *tolerância* é a margem, em minutos, para uma batida um pouco antes do início ainda contar naquele turno. Batida fora de qualquer turno ativo é registrada e sinalizada, não bloqueada.
- **Cadenciador** — calcula os ciclos entre o início e o fim do turno, pulando os intervalos. Se um turno rodar com equipe reduzida, cadastre um takt específico para ele em *Administração → Takt Times → Escopo: somente Turno X*.
- **ProGestão** — usa o turno do colaborador e nos apontamentos de produção.

Turnos que viram a meia-noite (ex.: `22:00 → 06:00`) precisam da opção **"Este turno vira a meia-noite"** marcada.

O seed cria o Turno 1 (`06:00–17:30`, com os três intervalos originais) ativo, e os Turnos 2 e 3 desativados como ponto de partida.

---

## Leitura NFC

A Web NFC API funciona no **Chrome para Android**, em conexão **HTTPS** (o domínio do Railway já é HTTPS). Em desktop e iOS o leitor não está disponível — a tela cai automaticamente para a batida manual, que pode ser desligada em *Administração → Parâmetros*.

O UID cadastrado precisa ser exatamente o que o aparelho lê. Se um crachá novo não for reconhecido, a tela mostra o UID lido na mensagem de erro: copie e cadastre em *Administração → Crachás NFC*.

---

## Estrutura

```
├── server.js                 Express: sessão, rotas, boot
├── db/
│   ├── index.js              pool do Postgres
│   ├── schema.js             schema completo + migrações idempotentes
│   └── seed.js               turnos, crachás, produtos, admin
├── lib/turnos.js             cálculo de ciclos e detecção de turno
├── lib/fotos.js              entidades que aceitam fotos, validação, migração
├── middleware/auth.js        requireAuth / requireAdmin
├── routes/                   16 arquivos de API (inclui limpeza.js e fotos.js)
└── public/                  (contador.html e contador-painel.html: módulo Contador; js/mediapipe/pose: IA local)
    ├── css/decio.css         design system da marca
    ├── js/core.js            API, avisos, cabeçalho, voz
    ├── js/fotos.js           upload com compressão, galeria e visualizador
    ├── login.html  index.html  admin.html
    ├── ponto.html  cadenciador.html
    └── progestao/            dashboard + 7 módulos
```

---

## Perfis de acesso

- **Administrador** — configura turnos, células, colaboradores, crachás, takt times, produtos, usuários e parâmetros.
- **Operação** — usa os três sistemas, cadastra colaboradores e lança dados, mas não altera a estrutura.

---

## Backup

O Railway faz snapshots do Postgres. Para um dump manual:

```bash
pg_dump "$DATABASE_URL" > backup_$(date +%F).sql
```

As fotos estão dentro do banco (tabela `fotos`), então o dump já as inclui.

Cada módulo também exporta Excel: `/api/export/ponto`, `/api/export/crachas`, `/api/export/takt`, `/api/export/ciclos`, `/api/export/paradas`, `/api/export/colaboradores`, `/api/export/ferramentas`, `/api/export/epis`, e assim por diante.

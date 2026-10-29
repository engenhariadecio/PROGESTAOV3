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

**Conta cada COLOCAÇÃO (antes × depois) + conferência com o Claude (29/10/2026) — v51**
- **Modo evento (padrão para os modelos de contorno/detecção)**: em vez de contar o pallet inteiro e somar a diferença, a câmera guarda o **antes** (pallet parado: 3 leituras iguais), espera alguém mexer e a cena parar de novo, tira o **depois** e conta a diferença **só se a imagem mudou de verdade em cima da pilha** (mudança mínima ~¼ de caixa, compensando a luz). Colocou 1 → +1; colocou 2 de uma vez → +2. As caixas que já estavam lá não influenciam; leitura que oscila sem ninguém mexer nunca soma. Leitura menor que antes = alguém tapando: espera (só vira retirada se continuar 20 s). Pallet que sai/esvazia ou chega carregado não conta. HUD: "✅ +1 colocada".
- Se a cena nunca para (mexendo sem parar por mais de 60 s), a leitura do pallet assume até parar (reserva).
- **🤖 Conferência com o Claude (opcional)**: com a variável `ANTHROPIC_API_KEY` no Railway (chave criada no Claude Console da Anthropic), a cada colocação o celular manda o recorte da pilha **antes** e **depois** para `POST /api/contador/conferir`, e o **Claude** responde quantas caixas foram colocadas — é o número que vale (com "certeza baixa" vale o da câmera). Sem internet / sem resposta em 25 s, vale o da câmera. Opcionais: `ANTHROPIC_MODEL` (padrão `claude-sonnet-5-5`), `CLAUDE_MAX_DIA` (limite de consultas/dia, padrão 3000). Só consulta quando alguém mexeu e a imagem mudou (não a cada segundo). Custo por consulta: ver a tabela de preços da API em docs.claude.com.
- Teste no PC: `CLAUDE_MOCK=1 python3 servidor_teste.py` simula o Claude e guarda as fotos enviadas em `teste_dados/conferir/`.
- Movimento sem parar por mais de 30 s: a leitura do pallet assume na hora (e já conta o que subiu desde o último "antes"); quando a cena para, conta só o que ainda faltava. Pallet que sai com caixas ainda não contadas: conta antes de registrar a saída. Pilha que some (tapada) e volta em menos de 1 min: compara com o "antes" de quando sumiu.
- Conferido com o vídeo da linha: pallet visível 20/20; pallet escondido 20/20; câmera longe e gente passando no fundo: todas as caixas colocadas depois do 1º momento parado da câmera. Conferência com o Claude testada com uma API simulada (fotos antes/depois conferidas uma a uma).

**Fim da contagem em dobro (28/10/2026) — v50**
- **Evento nunca é gravado duas vezes**: cada +1 sai do celular com um código único (`uid`). Se a resposta do servidor se perde no Wi-Fi e o celular reenvia — ou a página é recarregada / aberta em duas abas com eventos na fila —, o servidor reconhece o código e não grava de novo (coluna `cont_eventos.uid` com índice único). Antes, cada reenvio virava +1 a mais ("coloquei 2, contou 4").
- **Só UMA câmera conta cada célula**: cada página de câmera tem uma identidade; se um 2º aparelho (ou outra aba) abrir a câmera na mesma célula enquanto a 1ª está transmitindo, ele mostra "⚠ OUTRA CÂMERA JÁ CONTA ESTA CÉLULA — esta não conta", o servidor ignora os eventos dele e o painel avisa "2 câmeras abertas nesta célula". Quando a 1ª fecha, a outra assume sozinha (recalibra, sem contar o que já está no pallet).
- Conferido: celular perdendo a resposta de TODO 1º envio (11 eventos reenviados) + 2º celular aberto na mesma célula → 0 duplicados, total certo.

**Zoom automático na pilha e "uma caixa não vira duas" (28/10/2026) — v49**
- **Zoom na pilha**: depois de achar o pallet (ou a base da pilha), a IA passa a olhar um recorte em volta do pallet + caixas em que o pallet ocupa ~70 % da largura — o tamanho em que ela foi treinada — com folga em cima para a próxima caixa e o braço. Câmera longe, 0,5× ou área marcada grande deixam de "achatar" as caixas finas. Se o pallet sumir do recorte por 2 leituras, volta a procurar na área/quadro inteiro.
- **Uma caixa não vira duas**: os contornos das peças são comparados entre si; se 60 % do menor está dentro do maior (pedaço da mesma caixa ou a mesma caixa detectada duas vezes), fica só o de maior confiança.
- Conferido: câmera longe (pallet pequeno na imagem) — todas as caixas colocadas depois de ligar; pallet visível 20/20; pallet escondido — todas depois de ligar.

**Pallet coberto/invisível e número fixo na tela (28/10/2026) — v48**
- **Conta sem enxergar o pallet**: pallet coberto por papelão, cortado na imagem ou que a IA não reconhece — a **camada de baixo da pilha** (as caixas lado a lado com o fundo na mesma altura) vira o apoio; a área automática passa a ser a pilha inteira (com folga em cima para crescer). Antes ficava "Sem pallet" e não contava nada. Pallet novo coberto: ele só "aparece" quando a 1ª caixa é colocada — essas 1–2 caixas contam.
- **Número fixo na tela**: o painel e o celular mostram a contagem **confirmada** da pilha; a leitura do momento só aparece entre parênteses quando difere ("pilha com 12 peças (lendo 13…)").
- **Decisão pela leitura que mais se repete** (moda) nos últimos ~6 s (antes: mediana em ~4 s). Empate fica com a confirmada; trocar de número pede 70 % das leituras (manter, 60 %).
- Pallet que vai de 1+ caixas a 0 é sempre troca de pallet (não desconta). Pallet/pilha que some e **volta em menos de 1 min com pelo menos as mesmas caixas** é o mesmo pallet (alguém tapou): conta só as caixas a mais. Sem pallet e sem pilha, caixa solta não conta.
- Conferido no replay do vídeo da linha: pallet visível 20/20, pallet escondido da IA 20/20, gente passando no fundo com área grande marcada: todas as caixas colocadas depois de ligar.

**Conta só caixa colocada no pallet; lente 0,5×; movimento só na pilha (28/10/2026) — v47**
- **Só conta caixa COLOCADA**: o que já está no pallet quando a câmera liga (ou ao recalibrar / trocar de câmera / mudar o zoom) é o ponto de partida e não conta. Removido o "já no pallet ao ligar".
- **Só conta o que está EM CIMA DO PALLET**: a caixa tem que estar apoiada no pallet ou numa caixa que já está na pilha (pelo menos metade dela em cima). Caixa plástica, caixa no chão ao lado, outra pilha — mesmo dentro da área — ficam de fora e aparecem em cinza. Entre vários "pallets" que a IA vê, vale o que tem a pilha em cima (ela às vezes marca um falso no topo da pilha).
- **Movimento só perto da pilha, e não trava**: o "tem alguém mexendo" (quando o celular não tem a IA de pessoas — Android antigo) olha só a pilha + margem para o braço (retângulo laranja pontilhado), não a área toda, e compensa a variação geral de luz. Com movimento a contagem **continua**: só aceita leitura bem firme (80 % das leituras concordando por uns 3–4 s) e só para **somar**; "menos caixas" com movimento é alguém tapando a pilha e é ignorado (só desconta depois que parar de mexer). Com a IA de pessoas, pessoa na frente do pallet ainda pausa a leitura.
- **Troca de pallet sem ver o "sem pallet"**: pallet cheio → vazio (ou queda de 3+ caixas de uma vez sem ninguém mexendo) é pallet trocado, não retirada — não desconta. Subida de 3+ de uma vez é pallet que chegou carregado — não conta (com "várias por vez" o limite é 6).
- **🔍 Achar a lente 0,5×** (*Configurar câmera → Câmera*): o celular tira uma foto com cada câmera traseira e o painel mostra lado a lado — é só clicar na que mostra mais da cena. Se o celular só libera uma câmera traseira ao navegador, o painel avisa (aí o 0,5× não existe pelo site nesse aparelho). Nomes das lentes mais claros na lista ("Traseira — lente 2").
- **Imagem na proporção certa**: celular em pé manda 480×640 (antes era espremido em 640×480 — imagem do painel distorcida e fotos de treino deformadas). Área marcada à mão: a IA dá mais zoom na pilha (margem de 8 %).

**Contagem garantida: pallet pequeno na imagem, sem oscilar (27/10/2026) — v46**
- **Decisão por mediana + prazo**: a contagem estável é a *mediana* das leituras dos últimos segundos (uma leitura que oscila não derruba a decisão) e, se as leituras nunca concordarem (câmera tremendo, luz piscando), decide mesmo assim 12 s depois de a pessoa sair — não trava mais em "Confirmando…". O HUD mostra "Confirmando… (NN % das leituras)".
- **Peça não some sozinha**: "menos peças" sem ninguém ter chegado perto do pallet desde a última contagem é a IA oscilando — ignorado, a contagem fica. Voltar à contagem de antes da última mudança (16→15→16) só com leituras muito firmes. Se a diferença persistir 25 s sem ninguém, a referência se ajusta em silêncio (como antes).
- **Pallet pequeno na imagem / câmera longe**: sem área marcada, a IA alterna o quadro inteiro com recortes (centro, esquerda, direita) até achar o pallet; com área, se o pallet sumir do recorte, 1 em cada 3 leituras volta ao quadro inteiro (e não fica preso no quadro inteiro como antes). Pallet "plausível" = ≥ 22 % da largura do quadro **ou** do recorte, ou onde já estava, ou com peças apoiadas em cima — e entre vários, o que está onde o pallet já estava (não pula para uma falsa detecção na borda).
- Modelo **Caixa/Pallet** re-treinado com cópias "de longe" (cena reduzida a 45–75 %): conta certo no quadro inteiro sem recorte (10/16/0/14 nos quadros de referência; o anterior dava 8/11/0/9). Arquivo `Caixa_Pallet.iamodelo` atualizado — importe e marque ⭐ padrão.
- Conferido no replay do vídeo da linha (celular na cadeira) e numa simulação de celular filmando o monitor: 30 peças nos dois (16 do 1º pallet + troca de pallet + 14 do 2º) — total exato.

**Ensinar com vídeo, importar/exportar modelo, IA no recorte (27/10/2026) — v45**
- **📹 Ensinar com vídeo** (*Ensinar a IA*): escolhe o(s) vídeo(s) gravado(s) da posição da câmera (pallet vazio → caixas uma por vez), contorna o pallet no 1º quadro e clica em ▶ Processar. Tudo roda **no navegador** (o vídeo não sobe para o servidor): ele toca 16× mais rápido, acha os momentos em que a cena ficou parada e, a cada caixa nova, cria uma foto com os contornos acumulados (a caixa nova é a diferença com o momento parado anterior; só vale se aparecer em dois momentos seguidos, encostada no pallet/pilha e longe das bordas — pessoa parada, sombra e braço ficam de fora). Pallet que sai → nova sequência. Opção "o vídeo começa com o pallet vazio" (desmarque se começar carregado: só entram fotos depois da 1ª troca). Depois é conferir as fotos e treinar. 110 min de vídeo ≈ 7 min de processamento.
- **📥 Importar / 📤 Exportar modelo** (*Modelos salvos*): arquivo `.iamodelo` (cabeçalho JSON + ONNX) para levar um modelo do PC para o Railway ou guardar cópia. Rotas `GET /api/contador/modelos/:id/exportar`, `POST /api/contador/modelos/importar?nome=` (corpo cru, até 120 MB).
- **Câmera: a IA olha o recorte** em volta da área (pallet + altura da pilha, com margem) em vez do quadro inteiro — caixas finas empilhadas ficam com o dobro de pixels. Se o pallet sumir do recorte por 4 leituras, volta ao quadro inteiro. O recorte aparece pontilhado na tela.
- Modelo **Caixa/Pallet** treinado com o vídeo real da linha (caixas finas empilhadas em 2 colunas, 2 pallets, 304 imagens, contorno por caixa): acerto 99 % nas imagens de treino; conferido na contagem com o próprio vídeo. Arquivo `Caixa_Pallet.iamodelo` para importar.

**Contagem que não trava e soma direto (22/10/2026) — v44**
- A câmera ficava parada em "Calibrando" com celular mais lento: a IA de contorno faz poucas leituras por segundo e a regra pedia 3 leituras idênticas em 2,5 s. Agora a janela acompanha a velocidade do aparelho e a decisão é por **maioria** das leituras (≥ 75 %), então uma leitura que oscila não trava a contagem. O aviso da câmera mostra "IA a cada X s" quando o aparelho está lento.
- **Peças que já estavam no pallet ao ligar** a câmera são contadas (evento "peca (ja no pallet ao ligar)"). Ao recarregar a página ou religar, ela compara com o que já foi contado neste pallet (eventos desde a última troca de pallet) e soma só a diferença — não conta duas vezes.
- Qualquer movimento/mão/pessoa no pallet conta como "alguém mexeu" (antes precisava de movimento grande ou a IA de pessoa), então uma caixa colocada rápido não é mais ignorada.
- Até 50 peças num evento só (antes 4). Pallet sai → "pallet saiu"; pallet vazio entra → "pallet novo vazio"; a contagem continua somando.

**Modelos de IA salvos e reaproveitados + peças encostadas separadas (22/10/2026) — v43**
- **Biblioteca de modelos** (*Ensinar a IA › Modelos salvos*): cada treino vira um modelo com nome (ex.: **Caixa/Pallet**). O ⭐ **padrão** vale para todos os produtos; um produto pode escolher outro modelo em *Modelo usado neste produto*. O primeiro modelo treinado vira o padrão. Renomear, trocar o padrão e apagar pelo painel.
- **Treinar**: escolhe o modelo (treinar de novo um existente — substitui ele em todos os produtos que o usam — ou criar um novo) e quais fotos usar (de todos os produtos e todas as câmeras = modelo geral; ou só do produto). As câmeras baixam o modelo novo sozinhas (a versão faz parte do endereço, sem cache antigo).
- Tabelas: `cont_modelos` ganhou `nome`, `padrao`, `updated_at` (linha opcional); nova `cont_modelo_produto`. Rotas `GET/PUT/DELETE /api/contador/modelos`, `GET/PUT /api/contador/produtos/:id/modelo`, `GET /api/contador/treino/atual`. Ordem do modelo da câmera: o do produto → o padrão → o último treinado na câmera (versões antigas).
- **Ensinar a IA, passo 2**: cada foto é comparada com a **foto anterior** — só a peça que acabou de ser colocada é contornada, então peças/caixas **encostadas** ficam com um contorno cada (antes viravam um bloco só). Pallet vazio (passo 1) começa uma sequência nova.

**Treino da IA no Railway (22/10/2026) — v42**
- O Dockerfile instala a IA num ambiente Python separado (`/opt/ia`, `PYTHON_BIN=/opt/ia/bin/python`) em vez de `--break-system-packages` no Python do Debian, que podia falhar e deixava o treino indisponível ("Command failed: python3 -c import ultralytics…"). O build termina mostrando "IA: treino instalado — ultralytics x.y" ou "AVISO: treino da IA não foi instalado".
- O painel mostra a última linha do erro do Python (o motivo real) em vez de "Command failed".

**Recuperar a senha do admin (22/10/2026) — v41**
- O `ADMIN_PASS` só vale quando o administrador é criado (1º deploy). Para trocar a senha depois: variável `RESET_ADMIN_PASS=true` no Railway → redeploy → entra com o `ADMIN_PASS` → apaga a `RESET_ADMIN_PASS`. Se o banco não tiver nenhum admin, ele é criado mesmo com `SEED_ON_BOOT=false`.

**Pasta python leve para o GitHub (22/10/2026) — v40**
- Os pesos da IA (`python/pesos/*.pt`, ~43 MB) saíram do projeto: `python/pesos_ia.py` baixa o que precisa na 1ª vez (github.com/ultralytics/assets), e o Dockerfile já baixa o do contorno (`yolov8n-seg.pt`, 7 MB) no deploy. A pasta `python` ficou com ~30 KB. `.gitignore` ignora `python/pesos/*.pt`.

**Treino que funciona com poucas fotos (22/10/2026) — v39**
- Com poucas fotos (6–10), o treino fazia pouquíssimos ajustes e a IA ficava "tímida" (confiança abaixo de 35%: não detectava nada). Agora o `treinar.py` repete as fotos até ~100 por passada (cada repetição sai diferente pela variação automática). Nas fotos de teste do pallet/peça: de 0% para 89–97% de confiança.
- Passo 2 (Peça): se o **pallet saiu do lugar** (foi tirado para pôr a peça), o sistema avisa e não marca nada sozinho — antes ele marcava o "buraco" do pallet como peça e o pallet onde não havia pallet, e o treino aprendia errado. Também ignora manchas ralas (sombra/luz) e tudo que estiver longe do pallet; pedaços só se juntam se um estiver quase todo dentro do outro.
- Passo 1: se o pallet mudou de lugar desde a última foto vazia, pede para contornar de novo em vez de reaproveitar o contorno antigo.
- Câmera: quando a IA não reconhece nada, o aviso mostra a maior confiança vista (ex.: "máx. 12% — precisa de 35%").
- Servidor de teste: verifica o treino num processo separado e mostra o motivo real do erro; botão "↻ Verificar de novo"; conexões cortadas pelo celular não geram mais Traceback.

**IA de contorno + treino em 2 passos (22/10/2026) — v38**
- A marcação deixou de ser retângulo: cada peça e o pallet são marcados pelo **contorno** (polígono). A IA passou de detecção para **segmentação** (`python/pesos/yolov8n-seg.pt`, `treinar.py --modo seg`, rótulos YOLO-seg `classe x1 y1 x2 y2 …`) e aprende o formato exato. Na câmera, o contorno de cada peça aparece pintado na imagem; a contagem (+1 colocada, −1 retirada, pallet trocado) continua igual.
- *Ensinar a IA* tem **um fluxo só**, com duas coisas: **1) Pallet vazio** — captura e contorna o pallet uma vez (segurar e passar em volta); as próximas fotos vazias já vêm contornadas. **2) Peça** — coloca a peça, captura: a diferença com o pallet vazio vira o **contorno da peça sozinho**. Ajustes: arrastar os pontos, clicar num contorno + ✕ para apagar, contornar à mão o que faltou. A próxima captura salva a anterior. Mínimo 1 vazio + 3 com peça (ideal 3 + 15). Caixa conta como peça (classes: `peca`, `pallet`).
- Os modos antigos (retângulos caixa/peça/pallet e "vazio × com peças") saíram da tela; os modelos já treinados neles continuam funcionando. Marcações antigas em retângulo viram contorno de 4 pontos.
- `public/js/contorno.js`: máscara → polígono (rastreio de borda + simplificação), usado no painel e na câmera.

**Importar fotos e 🪄 Sugerir (22/10/2026) — v37**
- *Ensinar a IA*: **📁 Importar fotos** — várias de uma vez, do celular ou do PC (reduzidas para 1280 px, orientação corrigida); entram como quadros de treino junto com os da câmera.
- **🪄 Sugerir**: a IA propõe os retângulos e você só corrige. Antes do 1º treino usa a IA genérica (`python/pesos/yolov8s-oiv7.pt`, "Box" → caixa — erra bastante com caixas grandes/empilhadas); depois do 1º treino usa a **IA treinada daquela câmera**, que melhora a cada rodada (marcar → treinar → sugerir → corrigir → treinar). `python/sugerir.py`; rota `POST /api/contador/amostras/:id/sugerir`. Requer `onnxruntime` (já no Dockerfile/requirements).
- A tela de marcação segue o formato de cada foto (em pé/deitada) sem esticar.

**Assistente de treino: pallet vazio → peça sozinha (22/10/2026) — v36**
- *Ensinar a IA* abre no **Assistente** (padrão): **1)** captura o **pallet vazio** (na 1ª vez você marca o pallet; depois ele é marcado sozinho) — vira a imagem de referência; **2)** coloca **uma peça** (ou caixa), sai da frente e captura: o sistema compara com o pallet vazio e **acha a peça sozinho** (manchas de diferença de cor, compensando a câmera clarear/escurecer); você só confere e clica *Confirmar*. Repetindo com a peça em posições diferentes e depois com 2–3 peças, junta os quadros para o treino. Mínimo 3 vazios + 10 com peças. O modo manual continua disponível.
- Se o servidor não tiver o treino instalado, o painel avisa logo ao abrir (e os quadros continuam sendo guardados).
- Servidor de teste: link curto `https://IP:3000/c`, `http://IP:3001` redireciona para o https, IP principal primeiro e dicas de rede na tela.

**Deploy à prova de falha (22/10/2026) — v35**
- O Dockerfile não depende mais de arquivos da pasta `python` para montar a imagem (antes, um commit com o Dockerfile mas sem a pasta `python` derrubava o build) e a instalação do treino da IA é opcional: se falhar, o build segue e o sistema sobe (o botão *Treinar IA* avisa). `npm ci` cai para `npm install` se o lockfile não bater.

**Versão visível e sem cache velho (22/10/2026) — v34**
- `/api/health` responde a versão (`"versao": "34.0.0"`) e o portal mostra "versão 34" no rodapé: é o jeito de conferir qual versão o Railway está rodando.
- `.js`/`.css` passam a ser revalidados a cada carregamento (antes ficavam 1 h no cache do navegador e, logo depois de um deploy, a página nova podia rodar com o script antigo).

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

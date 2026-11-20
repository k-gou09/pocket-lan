// Client reseau : salle WebSocket, avatar a gauche, chat a droite.
// Les modules d'animation (avatar, lip-sync, voix, dictee) sont repris du projet
// d'origine : ils ne dependent pas du moteur d'infrence, seulement des evenements.

import { Avatar } from './avatar.js';
import { Speaker } from './tts.js';
import { Dictation } from './dictation.js';
import { Bus } from './bus.js';

const $ = (id) => document.getElementById(id);

const els = {
  app: $('app'),
  viewButtons: document.querySelectorAll('.view-btn'),
  engineChip: $('engineChip'),
  btnMic: $('btnMic'),
  iMicOn: document.querySelector('.i-mic-on'),
  iMicOff: document.querySelector('.i-mic-off'),
  btnStopTts: $('btnStopTts'),
  jumpDown: $('jumpDown'),
  engineDot: $('engineDot'),
  connectionState: $('connectionState'),
  userName: $('userName'),
  btnSettings: $('btnSettings'),
  btnNew: $('btnNew'),
  drawer: $('drawer'),
  scrim: $('scrim'),
  convList: $('convList'),
  convTitle: $('convTitle'),
  usageLine: $('usageLine'),
  messages: $('messages'),
  empty: $('empty'),
  input: $('input'),
  btnSend: $('btnSend'),
  iSend: document.querySelector('.i-send'),
  iStop: document.querySelector('.i-stop'),
  avatarPane: $('avatarPane'),
  avatarStage: $('avatarStage'),
  statusText: $('avatarStatusText'),
  dictationBadge: $('dictationBadge'),
  dictationLine: $('dictationLine'),
  dictationText: $('dictationText'),
  btnDictation: $('btnDictation'),
  btnStopSpeaking: $('btnStopSpeaking'),
  queueBadge: $('queueBadge'),
  queueText: $('queueText'),
  participantList: $('participantList'),
  serverInfo: $('serverInfo'),
  gateInfo: $('gateInfo'),
  toast: $('toast'),
  settingModel: $('settingModel'),
  settingContextLength: $('settingContextLength'),
  settingBudget: $('settingBudget'),
  settingMaxTokens: $('settingMaxTokens'),
  settingTemperature: $('settingTemperature'),
  settingReasoning: $('settingReasoning'),
  settingTts: $('settingTts'),
  settingMic: $('settingMic'),
  settingAutoSend: $('settingAutoSend'),
  settingVoice: $('settingVoice'),
  settingPersona: $('settingPersona'),
  btnApplyModel: $('btnApplyModel'),
  btnCloseDrawer: $('btnCloseDrawer'),
};

const CURRENT_KEY = 'pocket.currentConv';
const NAME_KEY = 'pocket.name';
const STATE_LABELS = {
  idle: 'repos',
  listening: 'ecoute',
  thinking: 'reflexion',
  speaking: 'parole',
  error: 'erreur',
};

const bus = new Bus();
const avatar = new Avatar(els.avatarStage);
const speaker = new Speaker(avatar, { lang: 'fr-FR' });
const dictation = new Dictation({ lang: 'fr-FR', continuous: true, interimResults: true });

let settings = {};
let globalSettings = {};
let personasList = [];
let session = null;
let conversations = [];
let current = null;
let busy = false;
let ws = null;
let reconnectTimer = 0;
let toastTimer = 0;
let heartbeat = 0;
const openBubbles = new Map();

// Mode d'affichage : chat seul, les deux volets, ou avatar seul.
const VIEW_KEY = 'pocket.viewMode';
const VIEWS = ['chat', 'split', 'avatar'];
let lastSentText = '';
let lastSpokenId = '';
let streamSpeakId = '';
let streamSpokenDone = false;
let gateWaiting = 0;
let stickToBottom = true;
let typingEl = null;

// Etat de l'avatar : trois sources, une seule est visible a la fois.
// La voix passe avant la dictee, la dictee passe avant l'etat du serveur :
// sans cette priorite le TTS serait coupe par un evenement 'idle'.
const sources = { server: 'idle', dictation: 'idle', tts: 'idle' };

function resolveAvatarState() {
  return sources.tts !== 'idle' ? sources.tts : sources.dictation !== 'idle' ? sources.dictation : sources.server;
}

// Le bus est la seule source de l'etat visible de l'avatar (regle du projet d'origine).
function applyAvatarState(state) {
  avatar.setState(state);
  // Le volet porte l'etat : les regles de avatar.css lisent data-state sur le conteneur.
  els.avatarPane.dataset.state = state;
  els.statusText.textContent = STATE_LABELS[state] || state;
  const speakingNow = speaker.speaking || speaker.lipActive;
  els.btnStopSpeaking.disabled = !speakingNow;
  els.btnStopTts.hidden = !speakingNow;
  const listening = dictation.state === 'listening';
  els.btnDictation.classList.toggle('is-active', settings.mic && listening);
  els.btnDictation.setAttribute('aria-pressed', listening ? 'true' : 'false');
  // Le bouton micro du composer fait le meme travail que celui du HUD.
  els.btnMic.classList.toggle('is-active', settings.mic && listening);
  els.btnMic.setAttribute('aria-pressed', listening ? 'true' : 'false');
  els.iMicOn.hidden = listening;
  els.iMicOff.hidden = !listening;
  refreshChip();
}

function setSource(name, state) {
  sources[name] = state;
  bus.emit('avatarState', resolveAvatarState());
}

function applyEmotion(emotion, duration = 2400) {
  bus.emit('avatarEmotion', { emotion, duration });
}

// ---------- outils ----------

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 5000);
}

function setDot(state, label) {
  els.engineDot.className = 'engine-dot ' + state;
  els.engineDot.title = label;
}

function setConnection(online) {
  els.connectionState.textContent = online ? 'connecte' : 'deconnecte';
  els.connectionState.classList.toggle('off', !online);
}

function formatWhen(ts) {
  if (!ts) return '';
  const date = new Date(ts * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(140, els.input.scrollHeight) + 'px';
}

// Auto-scroll intelligent : on ne suit le bas que si l'utilisateur y est deja ;
// sinon un pillier "nouveaux messages" lui permet de redescendre.
function nearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom(force) {
  if (force || stickToBottom) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  updateJumpPill();
}

function updateJumpPill() {
  els.jumpDown.hidden = stickToBottom;
}

// Bulle "en train d'ecrire" entre l'envoi et le premier morceau de la reponse.
function showTyping() {
  hideTyping();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.dataset.messageId = messageId;
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing-bubble';
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'typing-dot';
    bubble.appendChild(dot);
  }
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  typingEl = wrap;
  scrollToBottom();
}

function hideTyping() {
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

// Chip d'etat du moteur dans l'en-tete du chat : reflexion, file, parole, ecoute.
function refreshChip() {
  let label = '';
  if (busy) label = 'réflexion…';
  else if (gateWaiting > 0) label = 'file : ' + gateWaiting;
  else if (speaker.speaking || speaker.lipActive) label = 'parole';
  else if (dictation.state === 'listening') label = 'écoute';
  els.engineChip.hidden = !label;
  if (label) els.engineChip.textContent = label;
}

// Actions au survol d'un message : horodatage discret + copie.
function addMsgActions(wrap, bubble, ts) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  if (ts) {
    const time = document.createElement('span');
    time.className = 'msg-time muted';
    time.textContent = formatWhen(ts);
    actions.appendChild(time);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'msg-copy';
  copy.setAttribute('aria-label', 'Copier le message');
  copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>';
  copy.addEventListener('click', () => {
    const text = bubble.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast('Message copié.'),
        () => showToast('Copie impossible.'),
      );
    } else {
      showToast('Copie indisponible dans ce navigateur.');
    }
  });
  actions.appendChild(copy);
  wrap.appendChild(actions);
}

function addMsgTime(wrap, ts) {
  const actions = wrap.querySelector('.msg-actions');
  if (!actions || !ts || actions.querySelector('.msg-time')) return;
  const time = document.createElement('span');
  time.className = 'msg-time muted';
  time.textContent = formatWhen(ts);
  actions.prepend(time);
}

// Erreur affichee dans la conversation, avec une chance de retenter.
function appendErrorBubble(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.dataset.messageId = messageId;
  const bubble = document.createElement('div');
  bubble.className = 'bubble error';
  const label = document.createElement('span');
  label.textContent = text;
  bubble.appendChild(label);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry-btn';
  retry.textContent = 'Réessayer';
  retry.addEventListener('click', () => {
    if (busy) return;
    wrap.remove();
    sendText(lastSentText);
  });
  bubble.appendChild(retry);
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  scrollToBottom(true);
}

// Bascule du mode d'affichage : chat seul / les deux volets / avatar seul.
function setView(mode) {
  if (!VIEWS.includes(mode)) mode = 'split';
  els.app.dataset.view = mode;
  for (const btn of els.viewButtons) {
    const active = btn.dataset.view === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  localStorage.setItem(VIEW_KEY, mode);
}

// ---------- rendu du chat ----------

function appendUserMessage(message) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  if (message && message.id) wrap.dataset.messageId = message.id;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.appendChild(document.createTextNode(message.content));
  wrap.appendChild(bubble);
  addMsgActions(wrap, bubble, message.created_at);
  els.messages.appendChild(wrap);
}

function assistantRow(messageId) {
  let row = openBubbles.get(messageId);
  if (row) return row;

  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.dataset.messageId = messageId;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  // Le texte est un vrai noeud Text : appendData() n'existe que sur ce type de noeud.
  const textWrap = document.createElement('span');
  const textNode = document.createTextNode('');
  textWrap.appendChild(textNode);
  bubble.appendChild(textWrap);
  wrap.appendChild(bubble);
  addMsgActions(wrap, bubble, null);
  els.messages.appendChild(wrap);

  row = { wrap, bubble, textWrap, textNode, reasoningEl: null, reasoningNode: null };
  openBubbles.set(messageId, row);
  return row;
}

function appendAssistantMessage(message) {
  const row = assistantRow(message.id);
  row.textNode.textContent = message.content;
  addMsgTime(row.wrap, message.created_at);
  if (message.reasoning) {
    const line = document.createElement('span');
    line.className = 'reasoning';
    line.textContent = message.reasoning;
    // Le bloc de raisonnement precede la reponse.
    row.bubble.insertBefore(line, row.textWrap);
    row.reasoningEl = line;
  }
  refreshRegenerateButtons();
}


function refreshRegenerateButtons() {
  if (!els || !els.messages) return;
  const msgs = (current && current.messages) || [];
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
  const rows = els.messages.querySelectorAll('.msg.assistant');
  rows.forEach((row) => {
    const id = row.dataset.messageId || '';
    let actions = row.querySelector('.msg-actions');
    const can = !!(lastAssistant && id && id === lastAssistant.id && !busy);
    const existing = actions ? actions.querySelector('.regen-btn') : null;
    if (can) {
      if (!actions) {
        // devrait exister (addMsgActions), mais sécurité
        const bubble = row.querySelector('.bubble');
        if (!bubble) return;
        actions = document.createElement('div');
        actions.className = 'msg-actions';
        bubble.appendChild(actions);
      }
      if (!existing) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-action-btn regen-btn';
        btn.textContent = 'Régénérer';
        btn.title = 'Régénérer la réponse';
        btn.addEventListener('click', () => requestRegenerate());
        actions.appendChild(btn);
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

function requestRegenerate() {
  if (busy || !current) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Connexion perdue : reconnexion en cours.');
    return;
  }
  speaker.stop();
  setSource('tts', 'idle');
  setBusy(true);
  setSource('server', 'thinking');
  showTyping();
  sendEvent('regenerate', { conv_id: current.id });
}

function renderMessages() {
  els.messages.innerHTML = '';
  openBubbles.clear();
  if (!current) {
    els.empty.hidden = false;
    return;
  }
  for (const message of current.messages) {
    if (message.role === 'user') appendUserMessage(message);
    else appendAssistantMessage(message);
  }
  els.empty.hidden = current.messages.length > 0;
  stickToBottom = true;
  scrollToBottom(true);
  refreshRegenerateButtons();
}

function renderConversationList() {
  els.convList.innerHTML = '';
  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (current && conv.id === current.id ? ' is-active' : '');

    const text = document.createElement('div');
    text.className = 'conv-text';
    const title = document.createElement('div');
    title.className = 'conv-title';
    title.textContent = conv.title || 'Nouvelle conversation';
    const sub = document.createElement('div');
    sub.className = 'conv-sub';
    sub.textContent = formatWhen(conv.updated_at);
    text.appendChild(title);
    text.appendChild(sub);

    const del = document.createElement('button');
    del.className = 'conv-del';
    del.type = 'button';
    del.setAttribute('aria-label', 'Supprimer');
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteConversation(conv);
    });

    item.appendChild(text);
    item.appendChild(del);
    item.addEventListener('click', () => openConversation(conv.id));
    els.convList.appendChild(item);
  }
}

async function openConversation(convId) {
  const conv = conversations.find((c) => c.id === convId);
  if (!conv) return;
  current = conv;
  els.convTitle.textContent = conv.title || 'Nouvelle conversation';
  localStorage.setItem(CURRENT_KEY, conv.id);
  const response = await fetch('/api/conversations/' + conv.id + '/messages');
  const data = await response.json();
  current.messages = data.messages || [];
  renderMessages();
  renderConversationList();
}

async function newConversation() {
  const response = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await response.json();
  if (!data.conversation) return;
  conversations.unshift(data.conversation);
  await openConversation(data.conversation.id);
  els.input.focus();
}

async function deleteConversation(conv) {
  if (!confirm('Supprimer « ' + (conv.title || 'cette conversation') + ' » ?')) return;
  const response = await fetch('/api/conversations/' + conv.id, { method: 'DELETE' });
  const data = await response.json();
  if (data.error) {
    showToast(data.error);
    return;
  }
  conversations = conversations.filter((c) => c.id !== conv.id);
  if (current && current.id === conv.id) {
    current = null;
    if (conversations.length) await openConversation(conversations[0].id);
    else renderMessages();
  }
  renderConversationList();
}

// ---------- salle ----------

function sendEvent(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, ...payload }));
  return true;
}

function connect() {
  const url = new URL('/ws', location.href);
  if (session) url.searchParams.set('sid', session.id);
  url.searchParams.set('name', name());

  ws = new WebSocket(url.toString());

  ws.addEventListener('open', () => {
    setConnection(true);
    sendEvent('hello', { name: name() });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => sendEvent('ping'), 25000);
  });

  ws.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(data);
  });

  ws.addEventListener('close', () => {
    setConnection(false);
    clearInterval(heartbeat);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  });

  ws.addEventListener('error', () => {
    setConnection(false);
  });
}

function name() {
  const typed = els.userName.value.trim();
  if (typed) {
    localStorage.setItem(NAME_KEY, typed);
    return typed;
  }
  return localStorage.getItem(NAME_KEY) || 'invité';
}

function handleEvent(data) {
  switch (data.type) {
    case 'snapshot': {
      session = data.data.session;
      settings = data.data.settings;
      globalSettings = data.data.settings;
      personasList = data.data.personas || personasList;
      conversations = data.data.conversations || [];
      renderSettings();
      renderParticipants(data.data.participants || []);
      if (!current && conversations.length) openConversation(conversations[0].id);
      break;
    }

    case 'message': {
      const conv = data.conversation;
      if (!conversations.some((c) => c.id === conv.id)) conversations.unshift(conv);
      if (!current || current.id !== conv.id) current = { ...conv, messages: [] };
      els.convTitle.textContent = conv.title || 'Nouvelle conversation';
      els.empty.hidden = true;
      appendUserMessage(data.message);
      // Le message compte dans l'historique memoire des maintenant.
      current.messages.push(data.message);
      renderConversationList();
      scrollToBottom();
      break;
    }

    case 'chunk': {
      hideTyping();
      const row = assistantRow(data.message_id);
      if (data.kind === 'content') {
        row.textNode.appendData(data.delta);
        // TTS au fil de l'eau : seul l'onglet speaker reçoit speak=true.
        if (data.speak && settings.tts) {
          if (streamSpeakId !== data.message_id) {
            streamSpeakId = data.message_id;
            streamSpokenDone = false;
            speaker.beginStream();
          }
          if (!streamSpokenDone) speaker.feed(data.delta);
        }
      } else {
        if (!row.reasoningEl) {
          const line = document.createElement('span');
          line.className = 'reasoning';
          // Le bloc de raisonnement precede la reponse.
          row.bubble.insertBefore(line, row.textWrap);
          row.reasoningEl = line;
          row.reasoningNode = document.createTextNode('');
          line.appendChild(row.reasoningNode);
        }
        row.reasoningNode.appendData(data.delta);
      }
      scrollToBottom();
      break;
    }

    case 'done': {
      const row = openBubbles.get(data.message_id);
      const message = data.message;
      if (row) {
        row.textNode.textContent = message.content;
        if (data.used_reasoning && row.reasoningEl && !settings.showReasoning) {
          // Le texte rendu est celui constate : le champ reasoning, rien d'invente.
          row.reasoningEl.remove();
          row.reasoningEl = null;
          row.reasoningNode = null;
        }
        addMsgTime(row.wrap, message.created_at);
        row.wrap.dataset.messageId = message.id;
      } else {
        appendAssistantMessage({ ...message, reasoning: null });
      }
      openBubbles.delete(data.message_id);
      hideTyping();

      // On ne pousse la reponse que dans sa propre conversation.
      if (current && current.id === data.conv_id) {
        current.messages.push(message);
        refreshRegenerateButtons();
      }

      els.usageLine.textContent = data.usage && data.usage.total_tokens
        ? 'tokens : ' + data.usage.total_tokens + ' · ' + Math.round((data.elapsed_ms || 0) / 1000) + ' s'
        : '';

      setBusy(false);
      setSource('server', 'idle');

      // TTS : lecture au fil de l'eau si démarrée, sinon lecture complète.
      if (data.speak !== false && data.message_id !== lastSpokenId) {
        lastSpokenId = data.message_id;
        if (streamSpeakId === data.message_id && settings.tts) {
          streamSpokenDone = true;
          speaker.endStream();
        } else if (settings.tts && message.content) {
          speaker.speak(message.content);
        }
      } else if (streamSpeakId === data.message_id) {
        streamSpokenDone = true;
        speaker.endStream();
      }
      if (streamSpeakId === data.message_id) {
        streamSpeakId = '';
        streamSpokenDone = false;
      }

      applyEmotion(data.stopped ? 'neutral' : 'happy');
      renderConversationList();
      scrollToBottom();
      break;
    }

    case 'activity':
      renderParticipants(data.activity || []);
      break;

    case 'settings':
      settings = data.settings;
      renderSettings();
      break;

    case 'global':
      globalSettings = data.settings;
      renderSettings();
      break;

    case 'model':
      bus.emit('notice', 'Modele applique : ' + data.model);
      break;

    case 'notice':
      bus.emit('notice', data.message);
      break;

    case 'error': {
      hideTyping();
      setBusy(false);
      setSource('server', 'idle');
      applyEmotion('sad');
      // Erreur liee a une conversation : bulle dans le fil, pas seulement un toast.
      if (data.conv_id && current && data.conv_id === current.id) {
        appendErrorBubble(data.message);
      } else {
        showToast(data.message);
      }
      refreshChip();
      break;
    }

    case 'regenerate_start': {
      if (current && data.conv_id === current.id) {
        const msgs = current.messages || [];
        if (msgs.length && msgs[msgs.length - 1].role === 'assistant') {
          msgs.pop();
          renderMessages();
        }
        els.empty.hidden = (current.messages || []).length > 0;
      }
      break;
    }

    case 'message_removed': {
      if (current && data.conv_id === current.id) {
        current.messages = (current.messages || []).filter((m) => m.id !== data.message_id);
        renderMessages();
        els.empty.hidden = (current.messages || []).length > 0;
      }
      break;
    }

    case 'conversation':
      conversations.unshift(data.conversation);
      renderConversationList();
      break;

    case 'conversation_deleted':
      conversations = conversations.filter((c) => c.id !== data.conv_id);
      if (current && current.id === data.conv_id) current = null;
      renderConversationList();
      break;

    case 'pong':
      showGate(data.gate);
      break;

    default:
      break;
  }
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (data.ok) {
      const label = data.loaded && data.loaded.length
        ? 'LM Studio joignable · modele charge : ' + data.loaded.join(', ')
        : 'LM Studio joignable, mais aucun modele charge';
      setDot(data.loaded && data.loaded.length ? 'ok' : 'busy', label);
      if (!data.loaded || !data.loaded.length) bus.emit('notice', 'Aucun modele charge dans LM Studio : choisis un modele dans les reglages.');
    } else {
      setDot('err', data.error || 'LM Studio injoignable');
      bus.emit('notice', data.error || 'LM Studio injoignable : le serveur local doit etre allume sur le port 1234.');
    }
    showGate(data.gate);
  } catch {
    setDot('err', 'Serveur Pocket joignable, mais le controle de sante a echoue');
  }
}

function showGate(gate) {
  if (!gate) return;
  gateWaiting = gate.waiting || 0;
  els.gateInfo.textContent = gate.running + '/' + gate.limit + (gate.waiting ? ' · ' + gate.waiting + ' en attente' : '');
  els.queueBadge.hidden = gate.waiting <= 0;
  els.queueText.textContent = 'file ' + gate.waiting;
  refreshChip();
}

function renderParticipants(participants) {
  els.participantList.innerHTML = '';
  for (const participant of participants) {
    const item = document.createElement('li');
    item.className = 'participant ' + (participant.state || 'idle');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = (participant.name || 'invité') + (participant.typing ? ' · écrit' : '');
    item.appendChild(dot);
    item.appendChild(label);
    els.participantList.appendChild(item);
  }
}

// ---------- reglages ----------

function renderSettings() {
  els.settingBudget.value = settings.contextBudget || globalSettings.contextBudget || 0;
  els.settingMaxTokens.value = settings.maxTokens;
  els.settingTemperature.value = settings.temperature;
  fillPersonas(personasList);
  if (!els.settingContextLength.value) els.settingContextLength.value = 4096;

  els.settingTts.setAttribute('aria-checked', settings.tts ? 'true' : 'false');
  els.settingTts.textContent = settings.tts ? 'activée' : 'désactivée';
  els.settingMic.setAttribute('aria-checked', settings.mic ? 'true' : 'false');
  els.settingMic.textContent = settings.mic ? 'activé' : 'désactivé';
  els.settingAutoSend.setAttribute('aria-checked', settings.autoSend ? 'true' : 'false');
  els.settingAutoSend.textContent = settings.autoSend ? 'activé' : 'désactivé';
  els.settingReasoning.setAttribute('aria-checked', settings.showReasoning ? 'true' : 'false');
  els.settingReasoning.textContent = settings.showReasoning ? 'activé' : 'désactivé';

  els.btnDictation.disabled = !settings.mic;
  els.btnMic.disabled = !settings.mic;

  // La voix choisie est appliquee a ce navigateur seulement : elle n'est pas
  // partagee avec les autres utilisateurs.
  speaker.preferredVoice = settings.voice || '';
  speaker.refreshVoices();
  fillVoices();
}

function fillVoices() {
  els.settingVoice.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = speaker.voiceLabel || 'voix par défaut';
  els.settingVoice.appendChild(option);

  for (const voice of speaker.voices) {
    const choice = document.createElement('option');
    choice.value = voice.name;
    choice.textContent = voice.name + (voice.localService ? '' : ' (en ligne)');
    if (settings.voice && voice.name === settings.voice) choice.selected = true;
    els.settingVoice.appendChild(choice);
  }
}


function fillPersonas(list) {
  if (!els.settingPersona) return;
  const active = globalSettings.persona || (settings && settings.persona) || 'default';
  els.settingPersona.innerHTML = '';
  for (const persona of (list || [])) {
    const choice = document.createElement('option');
    choice.value = persona.id;
    choice.textContent = persona.name || persona.id;
    if (persona.id === active) choice.selected = true;
    els.settingPersona.appendChild(choice);
  }
  if (!els.settingPersona.options.length) {
    const choice = document.createElement('option');
    choice.value = active;
    choice.textContent = active;
    choice.selected = true;
    els.settingPersona.appendChild(choice);
  }
}

function fillModels(models) {
  els.settingModel.innerHTML = '';
  for (const model of models) {
    const choice = document.createElement('option');
    choice.value = model.id;
    choice.textContent = model.id + ' · ' + model.state + ' · ' + (model.quantization || '?');
    if (model.id === (globalSettings.model || settings.model)) choice.selected = true;
    els.settingModel.appendChild(choice);
  }
}

function sendSettingsPatch(patch) {
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.error) showToast(data.error);
    })
    .catch(() => showToast('Envoi des réglages impossible.'));
}

function sendGlobalPatch(patch) {
  fetch('/api/global', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.error) showToast(data.error);
    })
    .catch(() => showToast('Réglage partagé impossible.'));
}

// ---------- envoi ----------

function setBusy(value) {
  busy = value;
  els.iSend.hidden = value;
  els.iStop.hidden = !value;
  els.btnSend.classList.toggle('is-busy', value);
  els.btnSend.setAttribute('aria-label', value ? 'Arrêter la génération' : 'Envoyer');
  refreshRegenerateButtons();
}

function sendText(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (busy) {
    showToast("Réponse en cours : termine la génération avant d'envoyer un autre message.");
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Passerelle réseau perdue : reconnexion en cours.');
    return;
  }
  const convId = current ? current.id : '';
  lastSentText = clean;
  sendEvent('chat', { conv_id: convId, text: clean });
  els.input.value = '';
  autosize();
  setBusy(true);
  setSource('server', 'thinking');
  els.empty.hidden = true;
  showTyping();
}

// ---------- dictee ----------

function startDictation() {
  if (!settings.mic) return;
  if (!Dictation.supported) {
    showToast('Reconnaissance vocale indisponible dans ce navigateur.');
    return;
  }
  // La reconnaissance passe par le service en ligne du navigateur : hors ligne
  // elle ne peut rien produire. On n'ouvre pas le micro pour rien.
  if (!navigator.onLine) {
    showToast('Dictée indisponible hors ligne : la reconnaissance passe par le réseau.');
    return;
  }
  dictation.start();
}

function stopDictation() {
  dictation.stop();
}

dictation.on('state', (state) => {
  setSource('dictation', state === 'listening' ? 'listening' : 'idle');
  els.dictationBadge.hidden = !(settings.mic && state === 'listening');
  els.dictationLine.hidden = !(settings.mic && (state === 'listening' || els.dictationText.textContent));
});

// Le module de dictee ne produit que des evenements : c'est le bus qui decide
// ce qu'on en fait, comme dans le projet d'origine.
dictation.on('result', (result) => {
  els.dictationLine.hidden = false;
  els.dictationText.textContent = result.text;
  bus.emit('dictation', result);
});

dictation.on('error', (error) => {
  bus.emit('notice', error.message);
  setSource('dictation', 'error');
  setTimeout(() => setSource('dictation', 'idle'), 1600);
});

dictation.on('usage', (info) => bus.emit('notice', info.message));

speaker.onStateChange = (state) => {
  setSource('tts', state === 'speaking' ? 'speaking' : 'idle');
};

// ---------- bus ----------
// L'avatar n'est pilote que par le bus : aucun autre chemin ne touche son etat.
bus.on('avatarState', (state) => applyAvatarState(state));

bus.on('avatarEmotion', ({ emotion, duration }) => {
  avatar.setEmotion(emotion, duration);
  sendEvent('emotion', { emotion });
});

bus.on('dictation', (result) => {
  if (!result.isFinal) return;
  const text = String(result.text || '').trim();
  if (!text) return;
  const typed = els.input.value.trim();
  els.input.value = typed ? typed + ' ' + text : text;
  autosize();
  if (settings.autoSend && !busy) sendText(els.input.value);
});

bus.on('reply', ({ text }) => {
  if (settings.tts && text) speaker.speak(text);
});

bus.on('notice', (message) => showToast(message));

// ---------- interface ----------

function openDrawer() {
  els.drawer.classList.add('is-open');
  els.scrim.hidden = false;
}

function closeDrawer() {
  els.drawer.classList.remove('is-open');
  els.scrim.hidden = true;
}

function bind() {
  els.btnSettings.addEventListener('click', () => (els.drawer.classList.contains('is-open') ? closeDrawer() : openDrawer()));
  els.btnCloseDrawer.addEventListener('click', closeDrawer);
  els.scrim.addEventListener('click', closeDrawer);
  els.btnNew.addEventListener('click', newConversation);

  els.btnSend.addEventListener('click', () => {
    if (busy) {
      sendEvent('stop');
      return;
    }
    sendText(els.input.value);
  });

  els.input.addEventListener('input', () => {
    autosize();
    sendEvent('typing', { on: els.input.value.trim().length > 0 });
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.btnSend.click();
    }
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      els.input.value = chip.dataset.fill;
      autosize();
      sendText(els.input.value);
    });
  });

  // La dictee ne demarre jamais toute seule : le navigateur exige un geste.
  els.btnDictation.addEventListener('click', () => {
    if (dictation.state === 'listening') stopDictation();
    else startDictation();
  });

  els.btnStopSpeaking.addEventListener('click', () => {
    speaker.stop();
    setSource('tts', 'idle');
  });

  // Le bouton micro du composer : un seul bouton, deux etats (rec / stop).
  els.btnMic.addEventListener('click', () => {
    if (dictation.state === 'listening') stopDictation();
    else startDictation();
  });

  els.btnStopTts.addEventListener('click', () => {
    speaker.stop();
    setSource('tts', 'idle');
  });

  for (const btn of els.viewButtons) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }

  // "/" recentre sur le champ de saisie, sauf si on est deja dans un champ.
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/') return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    event.preventDefault();
    els.input.focus();
  });

  els.messages.addEventListener('scroll', () => {
    stickToBottom = nearBottom();
    updateJumpPill();
  });

  els.jumpDown.addEventListener('click', () => {
    stickToBottom = true;
    scrollToBottom(true);
  });

  els.settingTts.addEventListener('click', () => {
    sendSettingsPatch({ tts: !settings.tts });
    if (!settings.tts) {
      speaker.stop();
      setSource('tts', 'idle');
    }
  });

  els.settingMic.addEventListener('click', () => {
    sendSettingsPatch({ mic: !settings.mic });
    if (!settings.mic) stopDictation();
  });

  els.settingAutoSend.addEventListener('click', () => sendSettingsPatch({ autoSend: !settings.autoSend }));
  els.settingReasoning.addEventListener('click', () => sendSettingsPatch({ showReasoning: !settings.showReasoning }));

  els.settingVoice.addEventListener('change', () => {
    sendSettingsPatch({ voice: els.settingVoice.value });
  });

  els.settingBudget.addEventListener('change', () => sendSettingsPatch({ contextBudget: Number(els.settingBudget.value) || 0 }));
  els.settingMaxTokens.addEventListener('change', () => sendSettingsPatch({ maxTokens: Number(els.settingMaxTokens.value) || 512 }));
  els.settingTemperature.addEventListener('change', () => sendSettingsPatch({ temperature: Number(els.settingTemperature.value) || 0.7 }));

  els.settingPersona.addEventListener('change', () => sendGlobalPatch({ persona: els.settingPersona.value }));

  els.btnApplyModel.addEventListener('click', async () => {
    const response = await fetch('/api/model/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: els.settingModel.value,
        context_length: Number(els.settingContextLength.value) || undefined,
      }),
    });
    const data = await response.json();
    if (data.error) showToast(data.error);
    else if (data.note) showToast(data.note);
    else showToast('Modèle chargé : ' + data.model);
  });

  els.userName.addEventListener('change', () => {
    sendEvent('hello', { name: name() });
  });

  window.addEventListener('online', () => setConnection(ws && ws.readyState === WebSocket.OPEN));
  window.addEventListener('offline', () => showToast('Réseau perdu : la dictée est indisponible tant que le navigateur est hors ligne.'));
  if (window.speechSynthesis) window.speechSynthesis.addEventListener('voiceschanged', fillVoices);
}

async function boot() {
  setView(localStorage.getItem(VIEW_KEY) || 'split');
  bind();

  els.userName.value = localStorage.getItem(NAME_KEY) || '';

  try {
    const response = await fetch('/api/session');
    const data = await response.json();
    session = data.session;
    settings = data.settings;
    globalSettings = data.settings;
    personasList = data.personas || [];
    conversations = data.conversations || [];
    renderSettings();
    const last = localStorage.getItem(CURRENT_KEY);
    if (last && conversations.some((c) => c.id === last)) await openConversation(last);
    else if (conversations.length) await openConversation(conversations[0].id);
    else renderMessages();
    els.serverInfo.textContent = location.host;
  } catch (err) {
    showToast('Serveur joignable, mais session impossible : ' + err);
  }

  try {
    const models = await fetch('/api/models');
    const data = await models.json();
    fillModels(data.models || []);
  } catch {
    bus.emit('notice', 'Liste des modeles indisponible.');
  }

  await checkHealth();

  connect();
  setSource('server', 'idle');
}

// Poignee expose pour les tests depuis la console du navigateur.
window.__pocket = {
  bus,
  avatar,
  speaker,
  dictation,
  get settings() { return settings; },
  get session() { return session; },
  get conversations() { return conversations; },
  sendText,
  startDictation,
  stopDictation,
};

boot();

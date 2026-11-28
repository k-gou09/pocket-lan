// Client reseau : salle WebSocket, avatar a gauche, chat a droite.
// Les modules d'animation (avatar, lip-sync, voix, dictee) sont repris du projet
// d'origine : ils ne dependent pas du moteur d'infrence, seulement des evenements.

import { AvatarSwitch } from './avatar-switch.js';
import { Speaker, isFeminineVoice } from './tts.js';
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
  btnAttach: $('btnAttach'),
  attachMenu: $('attachMenu'),
  fileInput: $('fileInput'),
  imageInput: $('imageInput'),
  cameraInput: $('cameraInput'),
  attachPreview: $('attachPreview'),
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
  updateBanner: $('updateBanner'),
  updateText: $('updateText'),
  btnUpdateApply: $('btnUpdateApply'),
  btnUpdateDetails: $('btnUpdateDetails'),
  settingModel: $('settingModel'),
  settingBackend: $('settingBackend'),
  settingOllamaUrl: $('settingOllamaUrl'),
  rowOllamaUrl: $('rowOllamaUrl'),
  settingBudget: $('settingBudget'),
  settingTts: $('settingTts'),
  settingMic: $('settingMic'),
  settingAutoSend: $('settingAutoSend'),
  settingAvatar: $('settingAvatar'),
  settingVoice: $('settingVoice'),
  settingVoiceLabel: $('settingVoiceLabel'),
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
const avatar = new AvatarSwitch(els.avatarStage);
const speaker = new Speaker(avatar, { lang: 'fr-FR' });
const dictation = new Dictation({ lang: 'fr-FR', continuous: true, interimResults: true });

let settings = {};
let globalSettings = {};
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
let updateState = null;
let gateWaiting = 0;
let stickToBottom = true;
let typingEl = null;
// Message utilisateur ajoute localement des l'envoi, en attendant l'echo du serveur.
// Permet d'afficher le bubble "..." SOUS le message et non au-dessus.
let pendingLocalUserMsg = null;

// Pieces jointes en attente d'envoi (deja uploadees sur le serveur).
let pendingAttachments = [];
let lastSentAttachments = [];
const MAX_PENDING_FILES = 8;

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
  wrap.className = 'msg assistant typing';
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
  wrap.className = 'msg assistant error-msg';
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
    sendText(lastSentText, lastSentAttachments);
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

// ---------- pieces jointes ----------

function voiceKey() {
  if (avatar.id === 'nova') return 'voiceNova';
  if (avatar.id === 'iris') return 'voiceIris';
  return 'voice';
}

function attachmentIcon(kind) {
  return kind === 'image' ? '🖼️' : kind === 'pdf' ? '📄' : '📃';
}

function makeAttachmentItem(attachment) {
  const href = '/api/upload/' + encodeURIComponent(attachment.id);
  const link = document.createElement('a');
  link.className = 'attach-item';
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = attachment.name || 'Fichier joint';
  if (attachment.kind === 'image') {
    const thumb = document.createElement('img');
    thumb.className = 'attach-thumb';
    thumb.src = href;
    thumb.alt = '';
    link.appendChild(thumb);
  } else {
    const icon = document.createElement('span');
    icon.textContent = attachmentIcon(attachment.kind);
    link.appendChild(icon);
  }
  const name = document.createElement('span');
  name.textContent = attachment.name || 'Fichier';
  link.appendChild(name);
  return link;
}

function renderPendingAttachments() {
  const box = els.attachPreview;
  box.innerHTML = '';
  box.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach((attachment, index) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const label = document.createElement('span');
    label.textContent = attachmentIcon(attachment.kind) + ' ' + attachment.name;
    chip.appendChild(label);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Retirer ' + attachment.name);
    remove.addEventListener('click', () => {
      pendingAttachments.splice(index, 1);
      renderPendingAttachments();
    });
    chip.appendChild(remove);
    box.appendChild(chip);
  });
}

function openAttachMenu(open) {
  if (!els.attachMenu) return;
  els.attachMenu.hidden = !open;
  els.btnAttach.setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function uploadFiles(files) {
  const list = Array.from(files || []);
  for (const file of list) {
    if (pendingAttachments.length >= MAX_PENDING_FILES) {
      showToast('Maximum ' + MAX_PENDING_FILES + ' fichiers par message.');
      break;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('Fichier trop gros (5 Mo max) : ' + file.name);
      continue;
    }
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await response.json();
      if (data.error) {
        showToast(data.error);
        continue;
      }
      pendingAttachments.push(data.attachment);
      if (data.attachment.note) showToast(data.attachment.note);
    } catch {
      showToast('Envoi du fichier impossible : ' + file.name);
    }
  }
  renderPendingAttachments();
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
  const attachments = message.attachments || [];
  if (attachments.length) {
    const list = document.createElement('div');
    list.className = 'attach-list';
    for (const attachment of attachments) list.appendChild(makeAttachmentItem(attachment));
    wrap.appendChild(list);
  }
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


function applyUpdatePayload(data) {
  if (!data) return;
  if (Object.prototype.hasOwnProperty.call(data, 'update')) updateState = data.update || null;
  renderUpdateBanner();
}

function renderUpdateBanner() {
  if (!els.updateBanner || !els.updateText) return;
  const u = updateState || {};
  const available = !!u.update_available;
  const applying = !!u.applying;
  const status = String(u.apply_status || '');
  const msg = String(u.apply_message || '');

  let text = '';
  let show = false;
  if (applying) {
    show = true;
    text = msg || 'Mise à jour en cours...';
  } else if (status === 'error' && msg) {
    show = true;
    text = 'Mise à jour : ' + msg;
  } else if (available) {
    show = true;
    const latest = u.latest ? ` (${u.latest})` : '';
    text = `Mise à jour disponible${latest}.`;
  }

  if (!show) {
    els.updateBanner.hidden = true;
    return;
  }

  els.updateText.textContent = text;
  els.updateBanner.hidden = false;

  const canShowApply = available && !applying;
  els.btnUpdateApply.hidden = !canShowApply;
  els.btnUpdateApply.disabled = !!applying;
  els.btnUpdateApply.textContent = 'Mettre à jour';

  const hasUrl = !!u.url;
  els.btnUpdateDetails.hidden = !hasUrl;
}

async function triggerUpdateApply() {
  els.btnUpdateApply.disabled = true;
  try {
    const res = await fetch('/api/update/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error);
      els.btnUpdateApply.disabled = false;
      return;
    }
    applyUpdatePayload(data);
    showToast('Mise à jour lancée. Le serveur va redémarrer.');
  } catch (err) {
    showToast('Impossible de lancer la mise à jour : ' + err);
    els.btnUpdateApply.disabled = false;
  }
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
      conversations = data.data.conversations || [];
      renderSettings();
      renderParticipants(data.data.participants || []);
      applyUpdatePayload(data.data);
      if (!current && conversations.length) openConversation(conversations[0].id);
      break;
    }

    case 'message': {
      const conv = data.conversation;
      const newConv = !conversations.some((c) => c.id === conv.id);
      if (newConv) conversations.unshift(conv);
      if (!current || current.id !== conv.id) current = { ...conv, messages: [] };
      els.convTitle.textContent = conv.title || 'Nouvelle conversation';
      els.empty.hidden = true;
      const msg = data.message;
      const pending = pendingLocalUserMsg;
      pendingLocalUserMsg = null;
      // On n'absorbe l'echo que s'il vient bien de notre envoi : meme contenu,
      // role user, et meme conversation (ou nouvelle conversation cote client).
      const ours = msg.role === 'user' && pending && pending.content === msg.content
        && (pending.convId ? pending.convId === conv.id : newConv);
      const localEl = ours
        ? els.messages.querySelector('[data-message-id="' + pending.localId + '"]')
        : null;

      // Le message compte dans l'historique memoire des maintenant.
      current.messages.push(msg);
      if (ours && localEl && localEl.querySelector('.bubble').textContent === msg.content) {
        localEl.dataset.messageId = msg.id;
        const time = localEl.querySelector('.msg-time');
        if (time) time.textContent = formatWhen(msg.created_at);
      } else if (ours) {
        // DOM reconstruit entre temps : on re-rend depuis l'historique,
        // pas dans la conversation affichee par erreur.
        renderMessages();
        if (busy) showTyping();
      } else {
        appendUserMessage(msg);
      }
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
      pendingLocalUserMsg = null;
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

    case 'update':
      applyUpdatePayload(data);
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
    const name = data.label || 'Moteur local';
    if (data.ok) {
      const hasModels = data.loaded && data.loaded.length;
      const label = hasModels
        ? name + ' joignable · modèles : ' + data.loaded.join(', ')
        : name + ' joignable, mais aucun modèle disponible';
      setDot(hasModels ? 'ok' : 'busy', label);
      if (!hasModels) bus.emit('notice', 'Aucun modèle disponible dans ' + name + ' : choisis un modèle dans les réglages.');
    } else {
      setDot('err', data.error || name + ' injoignable');
      bus.emit('notice', data.error || name + ' injoignable : le serveur local doit être allumé.');
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

  const backend = globalSettings.backend || 'lms';
  if (els.settingBackend) els.settingBackend.value = backend;
  if (els.settingOllamaUrl) els.settingOllamaUrl.value = globalSettings.ollamaUrl || '';
  if (els.rowOllamaUrl) els.rowOllamaUrl.hidden = backend !== 'ollama';

  els.settingTts.setAttribute('aria-checked', settings.tts ? 'true' : 'false');
  els.settingTts.textContent = settings.tts ? 'activée' : 'désactivée';
  els.settingMic.setAttribute('aria-checked', settings.mic ? 'true' : 'false');
  els.settingMic.textContent = settings.mic ? 'activé' : 'désactivé';
  els.settingAutoSend.setAttribute('aria-checked', settings.autoSend ? 'true' : 'false');
  els.settingAutoSend.textContent = settings.autoSend ? 'activé' : 'désactivé';

  els.btnDictation.disabled = !settings.mic;
  els.btnMic.disabled = !settings.mic;

  // L'avatar et sa voix sont des reglages par utilisateur. Nova demarre sur une
  // voix feminine si le navigateur en expose une, sinon sur la voix francaise
  // par defaut ; l'utilisateur peut toujours la remplacer dans la liste.
  avatar.use(settings.avatar || 'pocket');
  speaker.preferFeminine = avatar.id === 'nova' || avatar.id === 'iris';
  speaker.preferredVoice = settings[voiceKey()] || '';
  speaker.refreshVoices();
  if (els.settingAvatar) els.settingAvatar.value = avatar.id;
  if (els.settingVoiceLabel) {
    els.settingVoiceLabel.textContent = avatar.id === 'nova'
      ? 'Voix de Nova (féminine)'
      : avatar.id === 'iris' ? "Voix d'Iris" : 'Voix (navigateur)';
  }
  fillVoices();
}

function fillVoices() {
  const key = voiceKey();
  els.settingVoice.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = speaker.voiceLabel || 'voix par défaut';
  els.settingVoice.appendChild(option);

  for (const voice of speaker.voices) {
    const choice = document.createElement('option');
    choice.value = voice.name;
    choice.textContent = voice.name
      + (isFeminineVoice(voice.name) ? ' ♀' : '')
      + (voice.localService ? '' : ' (en ligne)');
    if (settings[key] && voice.name === settings[key]) choice.selected = true;
    els.settingVoice.appendChild(choice);
  }
}


function fillModels(models) {
  els.settingModel.innerHTML = '';
  // Les modeles d'embedding ne savent pas discuter : on les masque quand un
  // modele de chat est disponible (meme filtre que le serveur).
  const usable = (models || []).filter(
    (model) => model.type !== 'embeddings' && !/embed|bge|nomic-embed/i.test(model.id || '')
  );
  if (usable.length) models = usable;
  const wanted = globalSettings.model || settings.model || '';
  let selected = false;
  for (const model of models) {
    const choice = document.createElement('option');
    choice.value = model.id;
    choice.textContent = model.id
      + (model.state ? ' · ' + model.state : '')
      + (model.quantization ? ' · ' + model.quantization : '');
    if (model.id === wanted) {
      choice.selected = true;
      selected = true;
    }
    els.settingModel.appendChild(choice);
  }
  // Après une bascule LM Studio <-> Ollama, l'ancien identifiant n'existe plus
  // dans la liste : on adopte le premier modèle disponible pour éviter un 404.
  if (!selected && models.length) {
    const first = models[0].id;
    els.settingModel.value = first;
    globalSettings.model = first;
    settings.model = first;
    if (wanted !== first) {
      sendGlobalPatch({ model: first });
      bus.emit('notice', 'Modèle adapté au backend : ' + first);
    }
  } else if (!models.length) {
    const choice = document.createElement('option');
    choice.value = '';
    choice.textContent = 'aucun modèle disponible';
    choice.selected = true;
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
  return fetch('/api/global', {
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

function sendText(text, attachmentIds = null) {
  const clean = String(text || '').trim();
  const ids = attachmentIds === null
    ? pendingAttachments.map((attachment) => attachment.id)
    : (attachmentIds || []).slice();
  if (!clean && !ids.length) return;
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
  lastSentAttachments = ids.slice();
  // Ajoute le message utilisateur au DOM AVANT le bubble "..." pour que
  // l'animation de reflexion apparaisse en dessous, et non au-dessus.
  const localId = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  // formatWhen() attend des secondes, comme time.time() cote serveur.
  const localAttachments = attachmentIds === null ? pendingAttachments.slice() : [];
  const localMsg = {
    id: localId, role: 'user', content: clean,
    created_at: Date.now() / 1000, attachments: localAttachments,
  };
  pendingLocalUserMsg = { localId, content: clean, convId };
  appendUserMessage(localMsg);
  sendEvent('chat', { conv_id: convId, text: clean, attachments: ids });
  pendingAttachments = [];
  renderPendingAttachments();
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

  if (els.btnAttach && els.attachMenu) {
    els.btnAttach.addEventListener('click', (event) => {
      event.stopPropagation();
      openAttachMenu(els.attachMenu.hidden);
    });
    els.attachMenu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-attach]');
      if (!button) return;
      openAttachMenu(false);
      const kind = button.dataset.attach;
      const input = kind === 'file' ? els.fileInput : kind === 'camera' ? els.cameraInput : els.imageInput;
      input.value = '';
      input.click();
    });
    document.addEventListener('click', (event) => {
      if (!els.attachMenu.hidden && !event.target.closest('.attach-wrap')) openAttachMenu(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') openAttachMenu(false);
    });
    for (const input of [els.fileInput, els.imageInput, els.cameraInput]) {
      input.addEventListener('change', () => {
        uploadFiles(input.files);
        input.value = '';
      });
    }
  }

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

  if (els.settingAvatar) {
    els.settingAvatar.addEventListener('change', () => sendSettingsPatch({ avatar: els.settingAvatar.value }));
  }

  els.settingVoice.addEventListener('change', () => {
    sendSettingsPatch({ [voiceKey()]: els.settingVoice.value });
  });

  if (els.settingBackend) {
    els.settingBackend.addEventListener('change', async () => {
      globalSettings.backend = els.settingBackend.value;
      renderSettings();
      await sendGlobalPatch({ backend: els.settingBackend.value });
      try {
        const response = await fetch('/api/models');
        const data = await response.json();
        fillModels(data.models || []);
      } catch {
        bus.emit('notice', 'Liste des modeles indisponible.');
      }
      await checkHealth();
    });
  }

  if (els.settingOllamaUrl) {
    els.settingOllamaUrl.addEventListener('change', () => {
      globalSettings.ollamaUrl = els.settingOllamaUrl.value.trim();
      sendGlobalPatch({ ollamaUrl: globalSettings.ollamaUrl }).then(checkHealth);
    });
  }

  els.settingBudget.addEventListener('change', () => sendSettingsPatch({ contextBudget: Number(els.settingBudget.value) || 0 }));

  if (els.btnUpdateApply) {
    els.btnUpdateApply.addEventListener('click', () => { triggerUpdateApply(); });
  }
  if (els.btnUpdateDetails) {
    els.btnUpdateDetails.addEventListener('click', () => {
      const url = updateState && updateState.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });
  }


  els.btnApplyModel.addEventListener('click', async () => {
    const response = await fetch('/api/model/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: els.settingModel.value }),
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
    conversations = data.conversations || [];
    applyUpdatePayload(data);
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
  get attachments() { return pendingAttachments; },
  uploadFiles,
  sendText,
  startDictation,
  stopDictation,
};

boot();
